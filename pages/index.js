// pages/index.js
import { useState, useRef } from "react";
import Tesseract from "tesseract.js";
import { HexColorPicker } from "react-colorful";

export default function Home() {
  const [file, setFile] = useState(null);
  const [ocrItems, setOcrItems] = useState([]); // {text, bbox: [x0,y0,x1,y1], conf}
  const [processing, setProcessing] = useState(false);
  const [mode, setMode] = useState("autodetect"); // or "custom"
  const [customTargets, setCustomTargets] = useState("credit_card,minecraft_coords,email");
  const [fillMode, setFillMode] = useState("fill"); // 'fill' or 'blur'
  const [color, setColor] = useState("#000000");
  const imgRef = useRef();
  const canvasRef = useRef();

  async function runOCR(file) {
    setProcessing(true);
    setOcrItems([]);
    const dataUrl = await toDataURL(file);
    // run Tesseract
    const { data } = await Tesseract.recognize(dataUrl, "eng", {
      logger: m => console.log(m)
    });
    // data.words contains words with bounding boxes
    const words = (data.words || []).map(w => ({
      text: w.text,
      conf: w.confidence,
      bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1]
    }));
    setOcrItems(words);
    setProcessing(false);
    return { words, dataUrl };
  }

  function toDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  async function onUpload(e) {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    const { words, dataUrl } = await runOCR(f);
    // show preview image by setting src
    if (imgRef.current) imgRef.current.src = dataUrl;
  }

  // send OCR payload to server to get which items to redact
  async function requestRedactions() {
    if (!file || !ocrItems.length) return alert("Upload an image first.");
    setProcessing(true);
    const payload = {
      items: ocrItems,
      mode,
      customTargets: customTargets.split(",").map(s => s.trim()).filter(Boolean)
    };
    const resp = await fetch("/api/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await resp.json();
    setProcessing(false);
    if (!resp.ok) return alert(json.error || "Server error");
    // json.redact_indices = array of indices in ocrItems that should be redacted
    drawRedactions(json.redact_indices || []);
  }

  // draw redactions on a canvas: either fill color or blur
  async function drawRedactions(indices) {
    const dataUrl = await toDataURL(file);
    const img = new Image();
    img.src = dataUrl;
    await new Promise(r => (img.onload = r));
    const canvas = canvasRef.current;
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    for (const i of indices) {
      const item = ocrItems[i];
      if (!item) continue;
      const [x0, y0, x1, y1] = item.bbox;
      const w = x1 - x0;
      const h = y1 - y0;
      if (fillMode === "fill") {
        ctx.fillStyle = color;
        ctx.fillRect(x0, y0, w, h);
      } else {
        // blur: use temporary canvas region, apply filter, then copy back
        const tmp = document.createElement("canvas");
        tmp.width = w;
        tmp.height = h;
        const tctx = tmp.getContext("2d");
        // copy region
        tctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
        // apply blur via filter
        tctx.filter = "blur(8px)";
        // draw the blurred region onto another canvas to apply filter
        const tmp2 = document.createElement("canvas");
        tmp2.width = w;
        tmp2.height = h;
        const t2 = tmp2.getContext("2d");
        t2.filter = "blur(8px)";
        t2.drawImage(tmp, 0, 0);
        // place back
        ctx.drawImage(tmp2, x0, y0);
      }
    }
  }

  function downloadCanvas() {
    const canvas = canvasRef.current;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "redacted.png";
    a.click();
  }

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, sans-serif" }}>
      <h1>AI Image Redactor (Gemini + Tesseract.js)</h1>

      <div>
        <input type="file" accept="image/*" onChange={onUpload} />
      </div>

      <div style={{ marginTop: 12 }}>
        <label>
          Mode:
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="autodetect">AI autodetect (recommended)</option>
            <option value="custom">Custom tokens</option>
          </select>
        </label>
        {mode === "custom" && (
          <input style={{ marginLeft: 12, width: 360 }} value={customTargets} onChange={(e)=>setCustomTargets(e.target.value)} />
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <label>
          Redaction style:
          <select value={fillMode} onChange={(e)=>setFillMode(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="fill">Colored fill</option>
            <option value="blur">Blur</option>
          </select>
        </label>
        {fillMode === "fill" && (
          <div style={{ display: "inline-block", marginLeft: 12 }}>
            <div style={{ width: 160 }}>
              <HexColorPicker color={color} onChange={setColor} />
            </div>
            <div style={{ marginTop: 6 }}>Chosen color: <span style={{ background: color, padding: "0 8px" }}>{color}</span></div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={requestRedactions} disabled={processing || !file}>
          {processing ? "Processing…" : "Run AI redaction"}
        </button>
        <button onClick={downloadCanvas} style={{ marginLeft: 8 }}>Download redacted image</button>
      </div>

      <div style={{ display: "flex", gap: 20, marginTop: 16 }}>
        <div>
          <h4>Original</h4>
          <img ref={imgRef} alt="original" style={{ maxWidth: 420, border: "1px solid #ccc" }} />
        </div>
        <div>
          <h4>Redacted</h4>
          <canvas ref={canvasRef} style={{ maxWidth: 420, border: "1px solid #ccc" }} />
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h4>OCR tokens (preview)</h4>
        <div style={{ maxHeight: 180, overflow: "auto", fontSize: 13, border: "1px solid #eee", padding: 8 }}>
          {ocrItems.length === 0 && <div>No OCR yet</div>}
          {ocrItems.map((w,i) => (
            <div key={i} style={{ padding: "4px 0", borderBottom: "1px dashed #f0f0f0" }}>
              <strong>#{i}</strong> [{w.conf}] — "{w.text}" — bbox: ({w.bbox.join(", ")})
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}