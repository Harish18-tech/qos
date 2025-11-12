(() => {
  const { jsPDF } = window.jspdf;
  // -------------------- Utilities --------------------
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const fmt = (n, d=2) => Number.isFinite(n) ? n.toFixed(d) : '-';
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // Seed defaults
  const flowsBody = $("#flowsBody");
  const defaults = [
    { name:"VoIP", type:"VoIP", size:160, ia:20, prio:1, w:5, dThr:150, jThr:30, lThr:1 },
    { name:"Video", type:"Video", size:1200, ia:10, prio:2, w:3, dThr:200, jThr:50, lThr:1 },
    { name:"Data", type:"Data", size:1500, ia:40, prio:3, w:1, dThr:1000, jThr:100, lThr:5 },
  ];

  function addFlowRow(f = null) {
    const i = flowsBody.children.length + 1;
    const d = f || { name:`Flow ${i}`, type:"Data", size:1000, ia:20, prio:2, w:1, dThr:300, jThr:50, lThr:2 };
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" value="${d.name}" aria-label="Flow name" style="width:120px;"></td>
      <td>
        <select aria-label="Flow type">
          <option ${d.type==="VoIP"?"selected":""}>VoIP</option>
          <option ${d.type==="Video"?"selected":""}>Video</option>
          <option ${d.type==="Data"?"selected":""}>Data</option>
          <option ${d.type==="Other"?"selected":""}>Other</option>
        </select>
      </td>
      <td><input type="number" min="40" step="1" value="${d.size}" aria-label="Packet size"></td>
      <td><input type="number" min="1" step="1" value="${d.ia}" aria-label="Inter arrival (ms)"></td>
      <td><input type="number" min="1" max="5" step="1" value="${d.prio}" aria-label="Priority"></td>
      <td><input type="number" min="1" max="20" step="1" value="${d.w}" aria-label="Weight"></td>
      <td><input type="number" min="1" step="1" value="${d.dThr}" aria-label="Delay threshold"></td>
      <td><input type="number" min="0" step="1" value="${d.jThr}" aria-label="Jitter threshold"></td>
      <td><input type="number" min="0" max="100" step="0.1" value="${d.lThr}" aria-label="Loss threshold"></td>
      <td><button class="btn" title="Remove flow">✕</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => tr.remove());
    flowsBody.appendChild(tr);
  }

  defaults.forEach(x => addFlowRow(x));

  // -------------------- Modals --------------------
  function openModal(id){ $("#"+id).classList.add("open"); }
  function closeModal(id){ $("#"+id).classList.remove("open"); }
  $("#btnLearn").addEventListener("click", () => openModal("modalLearn"));
  $("#btnDeveloped").addEventListener("click", () => openModal("modalDeveloped"));
  $("#btnHelp").addEventListener("click", () => openModal("modalHelp"));
  $$(".close").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
  $$(".modal").forEach(m => m.addEventListener("click", (e) => { if(e.target===m) m.classList.remove("open"); } ));

  // -------------------- Flow table actions --------------------
  $("#btnAddFlow").addEventListener("click", () => addFlowRow());
  $("#btnReset").addEventListener("click", () => {
    flowsBody.innerHTML = "";
    defaults.forEach(x => addFlowRow(x));
    $("#resultsBody").innerHTML = "";
    clearCharts();
    $("#simStatus").textContent = "Reset. Ready.";
  });

  // -------------------- Simulation Core --------------------
  function readInputs(){
    const linkMbps = Number($("#linkRate").value);
    const bufferPkts = Number($("#bufferPkts").value);
    const durationMs = Number($("#simDuration").value);
    const sched = $("#sched").value;

    const flows = [];
    $$("#flowsBody tr").forEach((tr, idx) => {
      const cells = tr.querySelectorAll("td");
      flows.push({
        id: idx,
        name: cells[0].querySelector("input").value || `Flow ${idx+1}`,
        type: cells[1].querySelector("select").value,
        sizeB: Number(cells[2].querySelector("input").value),
        iaMs: Number(cells[3].querySelector("input").value),
        prio: Number(cells[4].querySelector("input").value),
        weight: Number(cells[5].querySelector("input").value),
        thrDelayMs: Number(cells[6].querySelector("input").value),
        thrJitterMs: Number(cells[7].querySelector("input").value),
        thrLossPct: Number(cells[8].querySelector("input").value),
        color: pickColor(idx)
      });
    });

    return { linkMbps, bufferPkts, durationMs, sched, flows };
  }

  function pickColor(i){
    const palette = ["#0078D4","#7FBA00","#FFB900","#E81123","#5C2D91","#008272","#00B294","#D83B01","#038387","#107C10","#004E8C"];
    return palette[i % palette.length];
  }

  function simulate(){
    const cfg = readInputs();
    const { linkMbps, bufferPkts, durationMs, sched, flows } = cfg;
    if(flows.length === 0){ alert("Please add at least one flow."); return; }
    const linkBps = linkMbps * 1e6;
    const duration = durationMs / 1000; // s
    const log = [];

    // Pre-generate arrivals for each flow (deterministic inter-arrival)
    const arrivals = []; // {t, flowId, sizeB, seq}
    flows.forEach(f => {
      let t = 0; let seq = 0;
      const ia = Math.max(1, f.iaMs)/1000; // seconds
      while(t <= duration){
        arrivals.push({ t, flowId: f.id, sizeB: f.sizeB, seq });
        t += ia; seq++;
      }
    });
    arrivals.sort((a,b)=> a.t - b.t);

    // Queues
    const queues = new Map(); flows.forEach(f => queues.set(f.id, []));
    const globalQ = []; // for FIFO only (store packet references)
    let time = 0;
    let busyUntil = 0;
    let current = null;
    let nextArrivalIdx = 0;
    let totalEnqueued = 0;
    let dropped = new Map(); flows.forEach(f => dropped.set(f.id, 0));
    let delivered = new Map(); flows.forEach(f => delivered.set(f.id, 0));

    const records = new Map(); // per flow: delays, completed count
    flows.forEach(f => records.set(f.id, { delays:[], lastDelay:null }));

    // DRR state for WFQ
    const drr = {
      deficits: new Map(), q: [], quantumBase: 1500, // bytes
      ptr: 0
    };
    flows.forEach(f => { drr.deficits.set(f.id, 0); drr.q.push(f.id); });

    function totalBuffered(){
      let total = 0;
      if(sched === 'FIFO') total = globalQ.length;
      else queues.forEach(q => total += q.length);
      return total;
    }

    function enqueue(pkt){
      const f = flows.find(x=>x.id===pkt.flowId);
      if(totalBuffered() >= bufferPkts){
        dropped.set(f.id, dropped.get(f.id)+1);
        return false;
      }
      // Attach arrival metadata
      pkt.arrival = Math.max(pkt.t, time);
      if(sched === 'FIFO') globalQ.push(pkt);
      else queues.get(f.id).push(pkt);
      totalEnqueued++;
      return true;
    }

    function serviceTimeSec(sizeB){ return (sizeB*8) / linkBps; }

    function pickNextPacket(){
      if(sched === 'FIFO'){
        return globalQ.shift() || null;
      } else if(sched === 'PQ'){
        // Lower number = higher priority
        const byPrio = [...flows].sort((a,b)=> a.prio - b.prio);
        for(const f of byPrio){
          const q = queues.get(f.id);
          if(q.length) return q.shift();
        }
        return null;
      } else {
        // DRR (approx WFQ)
        const N = drr.q.length;
        let cycles = 0;
        while(cycles < N){
          const flowId = drr.q[drr.ptr];
          const f = flows.find(x=>x.id===flowId);
          const q = queues.get(flowId);
          // Add quantum per round
          drr.deficits.set(flowId, drr.deficits.get(flowId) + drr.quantumBase * Math.max(1,f.weight));
          if(q.length){
            const head = q[0];
            if(head.sizeB <= drr.deficits.get(flowId)){
              q.shift();
              drr.deficits.set(flowId, drr.deficits.get(flowId) - head.sizeB);
              drr.ptr = (drr.ptr + 1) % N;
              return head;
            }
          }
          drr.ptr = (drr.ptr + 1) % N;
          cycles++;
        }
        return null;
      }
    }

    // Main event loop
    while(time <= duration || current || nextArrivalIdx < arrivals.length || totalBuffered() > 0){
      // Next arrival time
      const nextA = (nextArrivalIdx < arrivals.length) ? arrivals[nextArrivalIdx].t : Infinity;
      // Next depart time
      const nextD = current ? busyUntil : Infinity;

      if(nextA <= nextD && nextA <= duration){
        // Process arrival
        time = Math.max(time, nextA);
        enqueue(arrivals[nextArrivalIdx]);
        nextArrivalIdx++;
        // If link idle, start service
        if(!current){
          const cand = pickNextPacket();
          if(cand){
            current = cand;
            const st = serviceTimeSec(cand.sizeB);
            busyUntil = time + st;
            cand.start = time;
            cand.finish = busyUntil;
          }
        }
      } else if(current){
        // Process departure
        time = Math.max(time, nextD);
        const fId = current.flowId;
        const delay = (current.finish - current.t) * 1000; // ms
        const rec = records.get(fId);
        rec.delays.push(delay);
        // jitter calc (IPDV mean absolute diff)
        rec.lastDelay = delay;
        delivered.set(fId, delivered.get(fId) + current.sizeB*8);
        // Next packet
        current = null;
        const cand = pickNextPacket();
        if(cand){
          current = cand;
          const st = serviceTimeSec(cand.sizeB);
          busyUntil = time + st;
          cand.start = time;
          cand.finish = busyUntil;
        }
      } else {
        // No current, next event is arrival after duration or queues still have items
        if(nextA !== Infinity && nextA <= duration){
          time = nextA; // advance to next arrival
          continue;
        }
        // No more arrivals within duration, drain queues
        const cand = pickNextPacket();
        if(cand){
          const st = serviceTimeSec(cand.sizeB);
          cand.start = Math.max(time, busyUntil, cand.arrival || time);
          time = cand.start;
          busyUntil = time + st;
          current = cand; current.finish = busyUntil;
        } else {
          break; // nothing left to do
        }
      }
    }

    // Metrics per flow
    const out = [];
    flows.forEach(f => {
      const rec = records.get(f.id);
      // Jitter: mean absolute diff of consecutive packet delays
      let jitter = 0;
      if(rec.delays.length > 1){
        let sum = 0;
        for(let i=1;i<rec.delays.length;i++){
          sum += Math.abs(rec.delays[i] - rec.delays[i-1]);
        }
        jitter = sum / (rec.delays.length - 1);
      }
      const avgDelay = rec.delays.length ? (rec.delays.reduce((a,b)=>a+b,0)/rec.delays.length) : 0;
      const thputMbps = (delivered.get(f.id) / duration) / 1e6;
      const totalArrivals = Math.floor((duration) / (Math.max(1,f.iaMs)/1000)) + 1;
      const lossPct = totalArrivals > 0 ? (dropped.get(f.id) / totalArrivals) * 100 : 0;
      const ok = (avgDelay <= f.thrDelayMs) && (jitter <= f.thrJitterMs) && (lossPct <= f.thrLossPct);

      out.push({
        id:f.id, name:f.name, color:f.color, avgDelay, jitter, throughput: thputMbps, lossPct,
        thrDelay: f.thrDelayMs, thrJitter: f.thrJitterMs, thrLoss: f.thrLossPct, ok,
        totals: { deliveredBits: delivered.get(f.id), totalArrivals, dropped: dropped.get(f.id) }
      });
    });

    const step = [];
    step.push(`# Procedure`);
    step.push(`- Scheduling: ${sched}`);
    step.push(`- Link capacity: ${cfg.linkMbps} Mbps`);
    step.push(`- Buffer size: ${cfg.bufferPkts} packets`);
    step.push(`- Duration: ${cfg.durationMs} ms`);
    step.push(`- Flows: ${cfg.flows.length}`);
    cfg.flows.forEach(f=>{
      step.push(`  - ${f.name}: size=${f.sizeB}B, ia=${f.iaMs}ms, prio=${f.prio}, weight=${f.weight}, thresholds(D/J/L)=${f.thrDelayMs}/${f.thrJitterMs}/${f.thrLossPct}`);
    });

    return { cfg, results: out, procedure: step.join("\n") };
  }

  // -------------------- Rendering --------------------
  function renderResults(sim){
    const tb = $("#resultsBody");
    tb.innerHTML = "";
    sim.results.forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span style="display:inline-flex;align-items:center;gap:.5rem;"><span style="width:10px;height:10px;border-radius:2px;background:${r.color};display:inline-block;"></span>${r.name}</span></td>
        <td>${fmt(r.throughput, 3)}</td>
        <td>${fmt(r.avgDelay, 2)}</td>
        <td>${fmt(r.jitter, 2)}</td>
        <td>${fmt(r.lossPct, 2)}</td>
        <td>${r.ok ? '<span class="pill ok">OK</span>' : '<span class="pill bad">Violated</span>'}</td>
      `;
      tb.appendChild(tr);
    });
    $("#simStatus").textContent = "Simulation completed.";
    drawCharts(sim);
    lastSim = sim;
  }

  // -------------------- Charts (Canvas 2D) --------------------
  let ctxT=null, ctxD=null, ctxJ=null, ctxL=null;
  const canvT = $("#chartThroughput");
  const canvD = $("#chartDelay");
  const canvJ = $("#chartJitter");
  const canvL = $("#chartLoss");

  function getCtx(c){
    // Set canvas width/height properly (retina)
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.floor(rect.width * dpr);
    c.height = Math.floor(rect.height * dpr);
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    return ctx;
  }

  function clearCharts(){
    [canvT, canvD, canvJ, canvL].forEach(c => {
      const ctx = getCtx(c);
      ctx.clearRect(0,0,c.width,c.height);
    });
  }

  function drawBarChart(canvas, items, valueKey, thresholdKey, valueFmt = (v)=>v.toFixed(2), unit=""){
    const ctx = getCtx(canvas);
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    ctx.clearRect(0,0,W,H);
    const pad = {t:28, r:16, b:36, l:40};

    const n = items.length;
    const bw = Math.max(20, (W - pad.l - pad.r) / (n*1.6));
    const gap = bw*0.6;
    // Scale
    const maxV = Math.max(...items.map(x => x[valueKey]), ...items.map(x => x[thresholdKey] ?? 0), 1);
    const y0 = H - pad.b, yTop = pad.t;
    // Grid
    ctx.strokeStyle="#eee"; ctx.lineWidth=1;
    for(let gy=0; gy<=4; gy++){
      const y = y0 - (y0 - yTop)* (gy/4);
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const val = (maxV * (gy/4)).toFixed(0);
      ctx.fillStyle="#616161"; ctx.font="12px Segoe UI"; ctx.fillText(val, 4, y-2);
    }
    // Bars
    items.forEach((it, idx) => {
      const x = pad.l + idx*(bw+gap);
      const v = it[valueKey];
      const h = (v/maxV) * (y0 - yTop);
      const y = y0 - h;
      const thr = it[thresholdKey] ?? null;
      const ok = (thr === null) ? true : (valueKey === 'throughput' ? true : v <= thr);

      // Threshold line
      if(thr !== null){
        const ty = y0 - (thr/maxV) * (y0 - yTop);
        ctx.strokeStyle = "#d0d0d0"; ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(pad.l-4, ty); ctx.lineTo(W - pad.r+4, ty); ctx.stroke();
        ctx.setLineDash([]);
      }

      // Bar
      ctx.fillStyle = ok ? it.color : "#D83B01";
      ctx.fillRect(x, y, bw, h);
      // Label
      ctx.fillStyle="#1b1a19"; ctx.font="11px Segoe UI"; ctx.fillText(it.name, x-2, y0+14);
      ctx.fillStyle="#616161"; ctx.fillText(valueFmt(v) + (unit?(" "+unit):""), x-2, y0+28);
    });
  }

  function drawCharts(sim){
    const items = sim.results.map(r => ({
      name: r.name, color: r.color,
      throughput: r.throughput, avgDelay: r.avgDelay, jitter: r.jitter, lossPct: r.lossPct,
      thrDelay: r.thrDelay, thrJitter: r.thrJitter, thrLoss: r.thrLoss
    }));
    drawBarChart(canvT, items, "throughput", null, v=>v.toFixed(3),"Mbps");
    drawBarChart(canvD, items, "avgDelay", "thrDelay", v=>v.toFixed(1),"ms");
    drawBarChart(canvJ, items, "jitter", "thrJitter", v=>v.toFixed(1),"ms");
    drawBarChart(canvL, items, "lossPct", "thrLoss", v=>v.toFixed(2),"%");
  }

  // -------------------- Download report --------------------
  let lastSim = null;
  function getChartImage(canvas) {
  return canvas.toDataURL("image/png");
}
  $("#btnDownload").addEventListener("click", () => {
  if (!lastSim) {
    alert("Please run a simulation first.");
    return;
  }

  const { cfg, results } = lastSim;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const margin = 14;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("QoS Parameter Analyzer Report", margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 10;

  // ---- Simulation Inputs ----
  doc.setFont("helvetica", "bold");
  doc.text("Simulation Inputs", margin, y);
  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const inputs = [
    `Link Capacity: ${cfg.linkMbps} Mbps`,
    `Buffer Size: ${cfg.bufferPkts} packets`,
    `Duration: ${cfg.durationMs} ms`,
    `Scheduling: ${cfg.sched}`,
    `Flows: ${cfg.flows.length}`
  ];
  inputs.forEach(line => { doc.text(line, margin, y); y += 5; });

  y += 4;
  cfg.flows.forEach(f => {
    doc.text(`• ${f.name} [${f.type}] size=${f.sizeB}B, ia=${f.iaMs}ms, prio=${f.prio}, w=${f.weight}`, margin + 4, y);
    y += 5;
  });

  // ---- Results Table ----
  y += 8;
  doc.setFont("helvetica", "bold");
  doc.text("Simulation Results", margin, y);
  y += 6;
  doc.setFont("helvetica", "normal");

  // Create table-like output
  doc.setFontSize(9);
  results.forEach(r => {
    doc.text(`${r.name}`, margin, y);
    doc.text(`Throughput: ${r.throughput.toFixed(3)} Mbps`, margin + 50, y);
    y += 4;
    doc.text(`Delay: ${r.avgDelay.toFixed(2)} ms`, margin + 10, y);
    doc.text(`Jitter: ${r.jitter.toFixed(2)} ms`, margin + 50, y);
    doc.text(`Loss: ${r.lossPct.toFixed(2)} %`, margin + 90, y);
    doc.text(`Status: ${r.ok ? "OK" : "Violated"}`, margin + 130, y);
    y += 6;
    if (y > 260) { doc.addPage(); y = margin; }
  });

  // ---- Add Charts ----
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.text("Charts", margin, y);
  y += 6;

  const chartCanvases = [
    { title: "Throughput", el: $("#chartThroughput") },
    { title: "Delay", el: $("#chartDelay") },
    { title: "Jitter", el: $("#chartJitter") },
    { title: "Loss", el: $("#chartLoss") }
  ];

  chartCanvases.forEach((ch) => {
  const img = getChartImage(ch.el);
  const imgProps = doc.getImageProperties(img);
  const pdfWidth = 80; // max width you want in PDF
  const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

  // Page break if not enough space left
  if (y + pdfHeight > 270) {  // 270 mm is near A4 bottom margin
    doc.addPage();
    y = margin;
  }

  doc.text(ch.title, margin, y);
  y += 4;
  doc.addImage(img, "PNG", margin, y, pdfWidth, pdfHeight);
  y += pdfHeight + 10; // keep small spacing before next chart
});

  doc.save("QoS_Analyzer_Report.pdf");
});

  // -------------------- Simulate button --------------------
  $("#btnSimulate").addEventListener("click", () => {
    $("#simStatus").textContent = "Simulating…";
    setTimeout(() => {
      const sim = simulate();
      renderResults(sim);
    }, 30);
  });

  // -------------------- Accessibility: Enter key submits --------------------
  document.addEventListener("keydown", (e) => {
    if(e.key === "Enter" && (e.metaKey || e.ctrlKey)){
      $("#btnSimulate").click();
    }
  });

  // Responsive redraw on resize (for crisp charts)
  let rAF=null;
  window.addEventListener("resize", () => {
    if(rAF) cancelAnimationFrame(rAF);
    rAF = requestAnimationFrame(() => { if(lastSim) drawCharts(lastSim); });
  });
})();