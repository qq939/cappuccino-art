// ============================================
// 卡布奇诺拉花 - 后端服务（Coze Workflow API 模式）
// ============================================
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8082;

const COZE_API_KEY = process.env.COZE_API_KEY;
const COZE_WORKFLOW_ID = process.env.COZE_WORKFLOW_ID || '7647377698306129920';
const COZE_API_BASE = 'https://api.coze.cn';
const OBS_BASE = 'http://obs.dimond.top';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname)));
app.use(express.json());

const PROMPTS_FILE = path.join(__dirname, 'prompts.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

const DEFAULT_PROMPT = `第一步：识别参考图中的视觉主体（人物、动物或物品），忽略背景。第二步：将该主体直接转化为咖啡拉花效果，严格保持主体的完整外貌、性别、五官、表情和所有特征不变，如同将主体抠出后以咖啡拉花的质感和色调重新呈现在咖啡表面。咖啡厅环境，木质桌面，柔和自然光，俯拍视角，专业咖啡摄影。`;

// ===== 工具函数 =====
function getImageSize(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 1) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      const segLen = buffer.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) return { width: buffer.readUInt16BE(26) & 0x3FFF, height: buffer.readUInt16BE(28) & 0x3FFF };
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4C) { const bits = buffer.readUInt32LE(21); return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 }; }
  }
  return null;
}

function calculateTargetSize(buffer) {
  const size = getImageSize(buffer);
  if (!size) return null;
  let { width, height } = size;
  if (width <= height) { const tW = 1080; const tH = Math.round(1080 * height / width); return { width: tW, height: Math.min(tH, 4320) }; }
  else { const tH = 1080; const tW = Math.round(1080 * width / height); return { width: Math.min(tW, 4320), height: tH }; }
}

function httpRequest(url, options, body) {
  const maxRedirects = options.maxRedirects || 5;
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqOptions = {
      hostname: parsedUrl.hostname, port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search, method: options.method || 'GET',
      headers: options.headers || {}, timeout: options.timeout || 120000,
    };
    const req = lib.request(reqOptions, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && maxRedirects > 0) {
        const location = res.headers.location;
        if (location) { const nextUrl = location.startsWith('http') ? location : new URL(location, url).href; return httpRequest(nextUrl, { ...options, maxRedirects: maxRedirects - 1 }, body).then(resolve).catch(reject); }
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const raw = Buffer.concat(chunks); resolve({ statusCode: res.statusCode, headers: res.headers, body: options.binary ? raw : raw.toString('utf8') }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function uploadToOBS(buffer, filename) {
  return new Promise((resolve, reject) => {
    const url = `${OBS_BASE}/${filename}`;
    const parsedUrl = new URL(url);
    const options = { hostname: parsedUrl.hostname, port: parsedUrl.port || 80, path: parsedUrl.pathname, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length } };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(body.trim() || url); else reject(new Error(`OBS upload failed: HTTP ${res.statusCode}`)); });
    });
    req.on('error', err => reject(new Error(`OBS network error: ${err.message}`)));
    req.write(buffer);
    req.end();
  });
}

async function fileToPublicUrl(file, prefix = 'img') {
  const ext = path.extname(file.originalname) || '.jpg';
  const hash = crypto.randomBytes(8).toString('hex');
  const filename = `cap_${prefix}_${Date.now()}_${hash}${ext}`;
  console.log(`[OBS] Upload ${filename} (${(file.size / 1024).toFixed(1)}KB)`);
  const publicUrl = await uploadToOBS(file.buffer, filename);
  console.log(`[OBS] OK: ${publicUrl}`);
  return publicUrl;
}

async function cozeWorkflowRun(prompt, imageUrl, imageSize) {
  if (!COZE_API_KEY || !COZE_WORKFLOW_ID) throw new Error('请配置 COZE_API_KEY 和 COZE_WORKFLOW_ID');
  const parameters = { prompt };
  if (imageUrl) parameters.image_url = imageUrl;
  if (imageSize) { parameters.width = String(imageSize.width); parameters.height = String(imageSize.height); }

  const requestBody = JSON.stringify({ workflow_id: COZE_WORKFLOW_ID, parameters });
  console.log(`[Workflow] Running, prompt=${prompt.substring(0, 60)}..., size=${imageSize ? imageSize.width + 'x' + imageSize.height : 'default'}`);

  const response = await httpRequest(`${COZE_API_BASE}/v1/workflow/run`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${COZE_API_KEY}`, 'Content-Type': 'application/json' }
  }, requestBody);

  const result = JSON.parse(response.body);
  if (result.code !== 0) throw new Error(`Workflow failed: ${result.msg}`);
  const debugUrl = result.debug_url || '';

  let outputData;
  try { outputData = JSON.parse(result.data); } catch (e) {
    if (typeof result.data === 'string' && result.data.startsWith('http')) return { imageUrl: result.data, debugUrl };
    throw new Error(`Output parse failed: ${e.message}`);
  }

  let foundUrl = null;
  if (outputData?.data) {
    if (typeof outputData.data === 'string' && outputData.data.startsWith('http')) foundUrl = outputData.data;
    else if (typeof outputData.data === 'object' && outputData.data.output) {
      const output = outputData.data.output;
      if (typeof output === 'string' && output.startsWith('http')) foundUrl = output;
      else if (Array.isArray(output) && output.length > 0) { const first = output[0]; if (typeof first === 'string') foundUrl = first; else if (first?.url) foundUrl = first.url; else if (first?.image_url) foundUrl = first.image_url; }
    }
  }
  if (!foundUrl && outputData?.output) {
    if (typeof outputData.output === 'string' && outputData.output.startsWith('http')) foundUrl = outputData.output;
    else if (Array.isArray(outputData.output) && outputData.output.length > 0) { const first = outputData.output[0]; if (typeof first === 'string') foundUrl = first; else if (first?.url) foundUrl = first.url; }
  }
  if (!foundUrl && typeof outputData === 'string' && outputData.startsWith('http')) foundUrl = outputData;

  if (foundUrl) return { imageUrl: foundUrl, debugUrl };
  console.error('[Workflow] Cannot parse output:', JSON.stringify(outputData).substring(0, 500));
  throw new Error('工作流未返回有效图片 URL');
}

async function downloadAndUploadToOBS(imageUrl, prefix = 'result') {
  console.log(`[OBS] Download: ${imageUrl.substring(0, 80)}...`);
  const response = await httpRequest(imageUrl, { method: 'GET', timeout: 60000, binary: true });
  if (response.statusCode !== 200) throw new Error(`Download failed: HTTP ${response.statusCode}`);
  const buffer = response.body;
  let ext = '.png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) ext = '.jpg';
  else if (buffer[0] === 0x89 && buffer[1] === 0x50) ext = '.png';
  else if (buffer[8] === 0x57 && buffer[9] === 0x45) ext = '.webp';

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  const hash = crypto.randomBytes(4).toString('hex');
  const filename = `cap_${prefix}_${ts}_${hash}${ext}`;
  console.log(`[OBS] Upload ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);
  const publicUrl = await uploadToOBS(buffer, filename);
  console.log(`[OBS] Saved: ${publicUrl}`);
  return { obsUrl: publicUrl, buffer };
}

// ===== 历史记录 =====
function loadHistory() { try { if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {} return []; }
function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf8'); }
function addHistory(record) { const h = loadHistory(); h.unshift(record); if (h.length > 200) h.length = 200; saveHistory(h); }

app.get('/api/history', (req, res) => res.json(loadHistory()));
app.delete('/api/history/:id', (req, res) => { const h = loadHistory(); const idx = h.findIndex(x => x.id === req.params.id); if (idx >= 0) { h.splice(idx, 1); saveHistory(h); res.json({ success: true }); } else res.status(404).json({ error: 'Not found' }); });
app.delete('/api/history', (req, res) => { saveHistory([]); res.json({ success: true }); });

// ===== 提示词 =====
function loadPrompts() { try { if (fs.existsSync(PROMPTS_FILE)) return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8')); } catch(e) {} return { prompt: '' }; }
function savePrompts(p) { fs.writeFileSync(PROMPTS_FILE, JSON.stringify(p, null, 2), 'utf8'); }
let customPrompts = loadPrompts();

app.get('/api/prompts', (req, res) => res.json(customPrompts));
app.post('/api/prompts', express.json(), (req, res) => { customPrompts.prompt = req.body.prompt ?? ''; savePrompts(customPrompts); res.json({ success: true, prompts: customPrompts }); });

// ===== 恢复初始 Demo =====
app.post('/api/reset-demo', (req, res) => {
  try {
    const srcOrig = path.join(__dirname, 'images', 'demo-source-original.jpg');
    const resOrig = path.join(__dirname, 'images', 'demo-result-original.jpg');
    const srcDest = path.join(__dirname, 'images', 'demo-source.jpg');
    const resDest = path.join(__dirname, 'images', 'demo-result.jpg');
    if (!fs.existsSync(srcOrig) || !fs.existsSync(resOrig)) return res.status(500).json({ error: '初始备份不存在' });
    fs.copyFileSync(srcOrig, srcDest);
    fs.copyFileSync(resOrig, resDest);
    const ts = Date.now();
    res.json({ success: true, sourceUrl: '/images/demo-source.jpg?t=' + ts, resultUrl: '/images/demo-result.jpg?t=' + ts });
  } catch (e) { res.status(500).json({ error: '恢复失败: ' + e.message }); }
});

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  const ok = !!(COZE_API_KEY && COZE_WORKFLOW_ID);
  res.json({ status: ok ? 'ok' : 'config_missing', mode: 'workflow-api', message: ok ? '服务已就绪' : '请配置 COZE_API_KEY 和 COZE_WORKFLOW_ID' });
});

// ===== 核心：生成 API =====
app.post('/api/generate', upload.single('image'), async (req, res) => {
  const imageFile = req.file;
  const userPrompt = req.body.prompt;
  if (!imageFile) return res.status(400).json({ error: '缺少 image 参数' });
  if (!COZE_API_KEY || !COZE_WORKFLOW_ID) return res.status(500).json({ error: '请配置环境变量' });

  try {
    const prompt = userPrompt || customPrompts.prompt || DEFAULT_PROMPT;
    const targetSize = calculateTargetSize(imageFile.buffer);
    const imageUrl = await fileToPublicUrl(imageFile, 'src');
    console.log(`[Generate] size=${targetSize ? targetSize.width + 'x' + targetSize.height : 'default'}`);

    const { imageUrl: resultUrl, debugUrl } = await cozeWorkflowRun(prompt, imageUrl, targetSize);
    const { obsUrl, buffer } = await downloadAndUploadToOBS(resultUrl, 'result');

    // 成对替换demo
    try {
      const ts = Date.now();
      fs.writeFileSync(path.join(__dirname, 'images', 'demo-source.jpg'), imageFile.buffer);
      fs.writeFileSync(path.join(__dirname, 'images', 'demo-result.jpg'), buffer);
      console.log(`[Demo] Paired replace OK`);
    } catch (e) { console.error('[Demo] Save failed:', e.message); }

    addHistory({ id: crypto.randomUUID(), imageUrl: obsUrl, debugUrl, sourceSize: imageFile.size, timestamp: new Date().toISOString() });
    console.log(`[Generate OK] OBS: ${obsUrl}`);
    res.json({ success: true, imageUrl: obsUrl, debugUrl });
  } catch (err) {
    console.error('Generate failed:', err);
    addHistory({ id: crypto.randomUUID(), imageUrl: '', debugUrl: '', error: err.message, sourceSize: imageFile.size, timestamp: new Date().toISOString() });
    res.status(500).json({ error: `生成失败: ${err.message}` });
  }
});

// ===== 启动 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n☕ 卡布奇诺拉花服务已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   Workflow ID: ${COZE_WORKFLOW_ID || '❌ 未配置'}`);
  console.log(`   API Key: ${COZE_API_KEY ? '✅' : '❌ 未配置'}`);
  console.log();
});
