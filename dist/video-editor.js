'use strict';
// Video files remain in the visitor's browser. No upload, model, or external CDN is used.
const $ = id => document.getElementById(id);
const video = $('video');
const analysisVideo = $('analysis-video');
const exportSource = $('export-source');
const exportCanvas = $('export-canvas');
let sourceFile = null;
let sourceUrl = null;
let resultUrl = null;
let duration = 0;
let cuts = [];
let cutCounter = 0;
let previewing = false;
let busy = false;
let analysisContext = null;
let analysisAnalyser = null;

function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function invalidateResult() {
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  $('result').textContent = '删减区间已变化，需重新导出视频。';
  $('progress').style.display = 'none';
}
function seconds(value) { return Number(value).toFixed(1) + ' 秒'; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function activeCuts() { return cuts.filter(c => c.enabled).sort((a, b) => a.start - b.start); }
function mergedCuts() {
  const merged = [];
  for (const cut of activeCuts()) {
    const start = clamp(cut.start, 0, duration), end = clamp(cut.end, 0, duration);
    if (end <= start) continue;
    const last = merged[merged.length - 1];
    if (last && start <= last.end + 0.001) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return merged;
}
function keptSegments() {
  const kept = []; let at = 0;
  for (const cut of mergedCuts()) {
    if (cut.start > at + 0.001) kept.push({ start: at, end: cut.start });
    at = Math.max(at, cut.end);
  }
  if (duration > at + 0.001) kept.push({ start: at, end: duration });
  return kept;
}
function outputDuration() { return keptSegments().reduce((sum, seg) => sum + seg.end - seg.start, 0); }
function preferredMime() {
  if (!window.MediaRecorder) return '';
  for (const mime of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}
function render() {
  const loaded = !!sourceFile && duration > 0;
  $('video-file').disabled = busy;
  $('demo-button').disabled = busy;
  for (const id of ['analyze', 'preview', 'add-cut', 'clear-cuts', 'export-list', 'export-fcpxml']) $(id).disabled = !loaded || busy;
  $('stop-preview').disabled = !previewing;
  $('export-video').disabled = !loaded || busy || outputDuration() < 0.2 || !preferredMime();
  $('filename').textContent = sourceFile ? sourceFile.name : '尚未选择视频';
  $('metrics').innerHTML = loaded ? `<span>原片 <strong>${seconds(duration)}</strong></span><span>准备删除 <strong>${seconds(duration - outputDuration())}</strong></span><span>保留 <strong>${seconds(outputDuration())}</strong></span>` : '';
  const list = $('cut-list'); list.replaceChildren();
  if (!cuts.length) {
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = loaded ? '尚无删减区间。可检测停顿，或手动输入开始、结束时间。' : '加载视频后，这里会显示检测到或手动添加的片段。';
    list.append(p);
  }
  cuts.sort((a, b) => a.start - b.start).forEach(cut => {
    const row = document.createElement('div'); row.className = 'cut-row';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = cut.enabled; check.setAttribute('aria-label', `删除 ${seconds(cut.start)} 至 ${seconds(cut.end)}`);
    check.disabled = busy;
    check.addEventListener('change', () => { cut.enabled = check.checked; invalidateResult(); render(); });
    const info = document.createElement('div'); info.style.flex = '1';
    const strong = document.createElement('strong'); strong.textContent = `${seconds(cut.start)} — ${seconds(cut.end)}`;
    const small = document.createElement('small'); small.textContent = `${cut.kind} · ${seconds(cut.end - cut.start)}`;
    info.append(strong, small);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.setAttribute('aria-label', `移除 ${seconds(cut.start)} 至 ${seconds(cut.end)} 的区间`);
    remove.disabled = busy;
    remove.addEventListener('click', () => { cuts = cuts.filter(item => item.id !== cut.id); invalidateResult(); render(); });
    row.append(check, info, remove); list.append(row);
  });
  renderTimeline();
}
function renderTimeline() {
  const timeline = $('timeline'); timeline.replaceChildren();
  if (!duration) return;
  for (let i = 1; i < 4; i++) {
    const tick = document.createElement('div'); tick.className = 'tick'; tick.style.left = i * 25 + '%';
    const label = document.createElement('span'); label.textContent = seconds(duration * i / 4); tick.append(label); timeline.append(tick);
  }
  for (const cut of mergedCuts()) {
    const segment = document.createElement('div'); segment.className = 'cut';
    segment.style.left = cut.start / duration * 100 + '%'; segment.style.width = (cut.end - cut.start) / duration * 100 + '%';
    timeline.append(segment);
  }
  const head = document.createElement('div'); head.className = 'playhead'; head.id = 'playhead'; timeline.append(head);
  updatePlayhead();
}
function updatePlayhead() {
  if (!duration) return;
  const percent = clamp(video.currentTime / duration * 100, 0, 100);
  const head = $('playhead'); if (head) head.style.left = percent + '%';
  $('timeline').setAttribute('aria-valuenow', String(Math.round(percent)));
}
function seekFromTimeline(clientX) {
  if (!duration) return;
  const box = $('timeline').getBoundingClientRect();
  video.currentTime = clamp((clientX - box.left) / box.width, 0, 1) * duration;
}
function stopPreview() {
  previewing = false; video.pause(); render();
}
function previewFrame() {
  if (!previewing) return;
  for (const cut of mergedCuts()) {
    if (video.currentTime >= cut.start && video.currentTime < cut.end - 0.02) {
      video.currentTime = Math.min(cut.end + 0.01, duration); break;
    }
  }
  updatePlayhead();
  if (!video.ended) requestAnimationFrame(previewFrame); else stopPreview();
}
async function loadVideo(file) {
  if (!file || !(file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name))) { setStatus('请选择浏览器支持的视频文件。', 'error'); return; }
  if (file.size > 150 * 1024 * 1024) { setStatus('演示版请使用小于 150 MB 的视频。', 'error'); return; }
  stopPreview();
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  sourceFile = file; sourceUrl = URL.createObjectURL(file); duration = 0; cuts = [];
  $('result').textContent = '导出视频时会以正常速度播放原片，并跳过选中的片段。请保持页面打开；输出格式由浏览器支持情况决定。';
  video.src = sourceUrl; analysisVideo.src = sourceUrl; exportSource.src = sourceUrl;
  video.hidden = false; $('empty').hidden = true;
  setStatus('正在读取视频信息…'); render();
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('浏览器无法解码这个视频，请换 MP4 或 WebM。'));
      video.load();
    });
    duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error('演示版支持时长不超过 2 分钟的短视频。');
    setStatus('视频已载入。可以检测停顿，也可以手动标记删减。', 'good');
  } catch (error) {
    sourceFile = null; duration = 0; video.hidden = true; $('empty').hidden = false;
    setStatus(error.message, 'error');
  }
  render();
}
function detectSilences(samples, total) {
  if (!samples.length) return [];
  const maxRms = Math.max(...samples.map(p => p.rms));
  if (maxRms < 0.003) return [];
  const threshold = Math.max(0.004, Math.min(0.025, maxRms * 0.18));
  const found = []; let start = null; let last = 0;
  for (const point of samples) {
    const silent = point.rms < threshold;
    if (silent && start === null) start = point.time;
    if (!silent && start !== null) {
      if (point.time - start >= 0.42) found.push({ start: Math.max(0, start + 0.06), end: Math.min(total, point.time - 0.06) });
      start = null;
    }
    last = point.time;
  }
  if (start !== null && last - start >= 0.42) found.push({ start: Math.max(0, start + 0.06), end: total });
  return found.filter(p => p.end - p.start >= 0.25);
}
async function scanSilence() {
  if (!sourceFile || busy) return;
  video.pause(); previewing = false;
  busy = true; render(); setStatus('正在扫描音频停顿。请保持此页在前台…');
  try {
    if (!analysisContext) {
      analysisContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = analysisContext.createMediaElementSource(analysisVideo);
      analysisAnalyser = analysisContext.createAnalyser(); analysisAnalyser.fftSize = 2048;
      const silentOutput = analysisContext.createGain(); silentOutput.gain.value = 0;
      source.connect(analysisAnalyser); analysisAnalyser.connect(silentOutput); silentOutput.connect(analysisContext.destination);
    }
    await analysisContext.resume();
    analysisVideo.currentTime = 0; analysisVideo.playbackRate = 2;
    const values = new Float32Array(analysisAnalyser.fftSize); const samples = [];
    await new Promise((resolve, reject) => {
      analysisVideo.onended = resolve;
      analysisVideo.onerror = () => reject(new Error('音频扫描失败，请改用手动标记。'));
      let previous = -1;
      const sample = () => {
        if (analysisVideo.ended) return;
        const at = analysisVideo.currentTime;
        if (at > previous + 0.025) {
          analysisAnalyser.getFloatTimeDomainData(values);
          let sum = 0; for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
          samples.push({ time: at, rms: Math.sqrt(sum / values.length) }); previous = at;
          if (samples.length % 15 === 0) setStatus(`正在扫描音频：${Math.round(at / duration * 100)}%`);
        }
        requestAnimationFrame(sample);
      };
      analysisVideo.play().then(sample).catch(reject);
    });
    const found = detectSilences(samples, duration);
    cuts = cuts.filter(c => c.kind === '手动标记').concat(found.map(p => ({ id: ++cutCounter, ...p, enabled: true, kind: '自动检测 · 待确认' })));
    invalidateResult();
    setStatus(found.length ? `检测到 ${found.length} 处可能的停顿。请逐条试听并确认。` : '没有检测到明确停顿，可能是持续背景音乐、无音轨或音量较低；可手动标记。', found.length ? 'good' : '');
  } catch (error) { setStatus(error.message || '扫描失败，请手动标记。', 'error'); }
  finally { analysisVideo.pause(); busy = false; render(); }
}
function addCut() {
  const start = Number($('cut-start').value), end = Number($('cut-end').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end - start < 0.1) { setStatus('请输入有效区间：结束晚于开始，且在视频时长内。', 'error'); return; }
  cuts.push({ id: ++cutCounter, start, end, enabled: true, kind: '手动标记' });
  invalidateResult();
  $('cut-start').value = ''; $('cut-end').value = '';
  setStatus('已添加。可取消勾选或预览删减效果。', 'good'); render();
}
function download(content, mime, filename) {
  const objectUrl = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a'); link.href = objectUrl; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}
function exportList() {
  if (!sourceFile) return;
  download(JSON.stringify({ note: '本地粗剪清单；不含原片。请人工核对。', source: sourceFile.name, duration, delete: mergedCuts(), keep: keptSegments() }, null, 2), 'application/json', '同频-粗剪清单.json');
}
function escapeXml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]); }
function exportFcpxml() {
  if (!sourceFile) return;
  const fps = 30, width = video.videoWidth || 1920, height = video.videoHeight || 1080;
  const name = sourceFile.name.replace(/\.[^.]+$/, '');
  const tick = sec => Math.round(sec * fps);
  let offset = 0;
  const clips = keptSegments().map(segment => {
    const length = tick(segment.end - segment.start), at = offset; offset += length;
    return `            <asset-clip name="${escapeXml(name)}" offset="${at}/${fps}s" ref="r1" start="${tick(segment.start)}/${fps}s" duration="${length}/${fps}s" audioRole="dialogue" format="r2" tcFormat="NDF" />`;
  }).join('\n');
  const source = 'file:///__RELINK__/' + encodeURIComponent(sourceFile.name);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<fcpxml version="1.8">\n  <resources>\n    <format id="r2" frameDuration="1/${fps}s" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)" />\n    <asset id="r1" name="${escapeXml(name)}" src="${escapeXml(source)}" start="0/1s" duration="${tick(duration)}/${fps}s" format="r2" hasAudio="1" hasVideo="1" audioSources="1" audioChannels="2" audioRate="48k" />\n  </resources>\n  <library>\n    <event name="${escapeXml(name)}_粗剪">\n      <project name="${escapeXml(name)}_cut">\n        <sequence duration="${offset}/${fps}s" format="r2" tcStart="0/1s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">\n          <spine>\n${clips}\n          </spine>\n        </sequence>\n      </project>\n    </event>\n  </library>\n</fcpxml>`;
  download(xml, 'application/xml', name + '_实验性.fcpxml');
  setStatus('已下载实验性 FCPXML：默认按 30 帧生成；导入时需重连原片，尚未验证剪映兼容。');
}
async function exportEditedVideo() {
  if (!sourceFile || busy || !preferredMime() || outputDuration() < 0.2) return;
  busy = true; stopPreview(); render();
  $('progress').style.display = 'block'; $('progress-bar').style.width = '0%';
  $('result').textContent = '正在浏览器里实时录制剪后片段。请保持页面在前台，不要关闭工作台。';
  let context, stream, recorder;
  try {
    await new Promise((resolve, reject) => { if (exportSource.readyState >= 1) resolve(); else { exportSource.onloadedmetadata = resolve; exportSource.onerror = () => reject(new Error('导出时无法读取原片。')); exportSource.load(); } });
    const scale = Math.min(1, 960 / exportSource.videoWidth, 540 / exportSource.videoHeight);
    exportCanvas.width = Math.max(2, Math.round(exportSource.videoWidth * scale / 2) * 2);
    exportCanvas.height = Math.max(2, Math.round(exportSource.videoHeight * scale / 2) * 2);
    const paint = exportCanvas.getContext('2d');
    context = new (window.AudioContext || window.webkitAudioContext)();
    const source = context.createMediaElementSource(exportSource);
    const audioDestination = context.createMediaStreamDestination(); source.connect(audioDestination);
    await context.resume();
    paint.fillStyle = '#111a2b'; paint.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    stream = exportCanvas.captureStream(30);
    for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track);
    const mimeType = preferredMime(); recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2500000 });
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = () => reject(new Error('浏览器录制失败。')); });
    const skip = mergedCuts();
    let index = 0;
    exportSource.onended = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    exportSource.onseeking = () => { if (recorder.state === 'recording') recorder.pause(); };
    exportSource.onseeked = () => { if (recorder.state === 'paused') recorder.resume(); };
    const paintFrame = () => {
      if (recorder.state === 'inactive') return;
      const at = exportSource.currentTime;
      while (index < skip.length && at >= skip[index].end - 0.02) index++;
      if (index < skip.length && at >= skip[index].start && at < skip[index].end - 0.02) {
        exportSource.currentTime = Math.min(skip[index].end + 0.01, duration); index++;
      } else if (!exportSource.seeking && exportSource.readyState >= 2) {
        paint.drawImage(exportSource, 0, 0, exportCanvas.width, exportCanvas.height);
      }
      $('progress-bar').style.width = clamp(at / duration * 100, 0, 100) + '%';
      requestAnimationFrame(paintFrame);
    };
    exportSource.currentTime = 0;
    recorder.start(500);
    await exportSource.play();
    paintFrame();
    await finished;
    if (!chunks.length) throw new Error('没有生成视频数据，请换一个浏览器重试。');
    const blob = new Blob(chunks, { type: mimeType });
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const link = document.createElement('a'); link.className = 'link'; link.href = resultUrl;
    link.download = sourceFile.name.replace(/\.[^.]+$/, '') + '_粗剪.' + extension;
    link.textContent = `下载剪后视频（${extension.toUpperCase()}，${(blob.size / 1024 / 1024).toFixed(1)} MB）`;
    $('result').replaceChildren(link);
    $('progress-bar').style.width = '100%';
    setStatus('浏览器粗剪已完成。请播放导出文件检查声音和切口，再进剪映做字幕与精修。', 'good');
  } catch (error) {
    $('result').textContent = '导出未完成。原片和删减记录未改变。';
    setStatus(error.message || '浏览器不支持这段视频的录制，请下载清单或换浏览器。', 'error');
  } finally {
    exportSource.pause(); exportSource.onended = null; exportSource.onseeking = null; exportSource.onseeked = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (stream) stream.getTracks().forEach(track => track.stop());
    if (context) await context.close();
    busy = false; render();
  }
}
async function makeDemo() {
  if (busy) return;
  if (!preferredMime() || !HTMLCanvasElement.prototype.captureStream) { setStatus('此浏览器不支持生成模拟样片，请选择本地视频。', 'error'); return; }
  busy = true; render(); setStatus('正在生成 10 秒模拟样片。它只有提示音，没有真人语音…');
  let context, stream;
  try {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const paint = canvas.getContext('2d');
    stream = canvas.captureStream(24);
    context = new (window.AudioContext || window.webkitAudioContext)();
    const destination = context.createMediaStreamDestination();
    const tone = context.createOscillator(), gain = context.createGain();
    tone.type = 'sine'; tone.frequency.value = 240;
    tone.connect(gain); gain.connect(destination);
    const now = context.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    for (const [start, end] of [[0.1, 2.4], [3.6, 6.5], [7.9, 9.8]]) {
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.linearRampToValueAtTime(0.045, now + start + 0.06);
      gain.gain.setValueAtTime(0.045, now + end - 0.06);
      gain.gain.linearRampToValueAtTime(0.0001, now + end);
    }
    tone.start(now); tone.stop(now + 10);
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    const mimeType = preferredMime(), recorder = new MediaRecorder(stream, { mimeType });
    const chunks = []; recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = reject; });
    const started = performance.now();
    const draw = () => {
      const elapsed = Math.min((performance.now() - started) / 1000, 10);
      const title = elapsed < 2.5 ? '先确认客户的真实问题' : elapsed < 3.5 ? '停顿' : elapsed < 6.7 ? '再介绍核验过的产品信息' : elapsed < 7.9 ? '停顿' : '邀请客户提出具体问题';
      paint.fillStyle = '#17223b'; paint.fillRect(0, 0, 640, 360);
      paint.fillStyle = '#8fa3f8'; paint.fillRect(50, 76, 92, 6);
      paint.fillStyle = '#ffffff'; paint.font = 'bold 34px -apple-system, PingFang SC, sans-serif'; paint.fillText(title, 50, 175);
      paint.fillStyle = '#b5c2e0'; paint.font = '20px -apple-system, PingFang SC, sans-serif'; paint.fillText('同频 · 模拟口播节奏样片（非真人语音）', 50, 222);
      paint.fillStyle = '#6781e8'; paint.fillRect(50, 297, 540 * elapsed / 10, 7);
      if (elapsed < 10) requestAnimationFrame(draw); else if (recorder.state !== 'inactive') recorder.stop();
    };
    await context.resume(); recorder.start(500); draw(); await finished;
    const blob = new Blob(chunks, { type: mimeType });
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    await loadVideo(new File([blob], '同频-模拟口播节奏.' + extension, { type: mimeType }));
    setStatus('模拟样片已生成。点击「检测停顿」，再检查删减预览。', 'good');
  } catch (error) { setStatus('模拟样片生成失败，请选择本地视频。', 'error'); }
  finally { if (stream) stream.getTracks().forEach(track => track.stop()); if (context) await context.close(); busy = false; render(); }
}

$('video-file').addEventListener('change', event => { if (event.target.files[0]) loadVideo(event.target.files[0]); });
$('demo-button').addEventListener('click', makeDemo);
$('analyze').addEventListener('click', scanSilence);
$('add-cut').addEventListener('click', addCut);
$('clear-cuts').addEventListener('click', () => { cuts = []; invalidateResult(); render(); setStatus('已清空删减区间。'); });
$('preview').addEventListener('click', async () => { if (!sourceFile) return; previewing = true; video.currentTime = 0; render(); try { await video.play(); previewFrame(); } catch { stopPreview(); setStatus('无法播放这个视频。', 'error'); } });
$('stop-preview').addEventListener('click', stopPreview);
$('export-list').addEventListener('click', exportList);
$('export-fcpxml').addEventListener('click', exportFcpxml);
$('export-video').addEventListener('click', exportEditedVideo);
$('timeline').addEventListener('click', event => seekFromTimeline(event.clientX));
$('timeline').addEventListener('keydown', event => { if (!duration || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); video.currentTime = clamp(video.currentTime + (event.key === 'ArrowRight' ? 1 : -1), 0, duration); });
video.addEventListener('timeupdate', updatePlayhead);
video.addEventListener('ended', () => { if (previewing) stopPreview(); });
window.addEventListener('pagehide', () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); if (resultUrl) URL.revokeObjectURL(resultUrl); analysisVideo.pause(); exportSource.pause(); });
if (window.parent !== window && 'ResizeObserver' in window) {
  new ResizeObserver(() => window.parent.postMessage({ type: 'video-editor-height', height: document.documentElement.scrollHeight }, location.origin)).observe(document.body);
}
render();
