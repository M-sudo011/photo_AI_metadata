import ExifReader from 'exifreader';
import { createC2pa } from '@contentauth/c2pa-web';
import wasmSrc from '@contentauth/c2pa-web/resources/c2pa.wasm?url';
import './styles.css';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_STRING_LENGTH = 100_000;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_OBJECT_KEYS = 2_000;
const MAX_DEPTH = 16;

const fileInput = document.querySelector('#file-input');
const dropZone = document.querySelector('#drop-zone');
const workspace = document.querySelector('#workspace');
const resultsElement = document.querySelector('#results');
const statusElement = document.querySelector('#status');
const copyButton = document.querySelector('#copy-report');
const downloadButton = document.querySelector('#download-report');
const clearButton = document.querySelector('#clear-results');

let reports = [];
let c2paSdkPromise;

fileInput.addEventListener('change', () => {
  inspectFiles(fileInput.files);
  fileInput.value = '';
});

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
}

dropZone.addEventListener('drop', (event) => {
  inspectFiles(event.dataTransfer.files);
});

clearButton.addEventListener('click', clearResults);
copyButton.addEventListener('click', copyReports);
downloadButton.addEventListener('click', downloadReports);

async function inspectFiles(fileList) {
  const selected = Array.from(fileList || []).slice(0, MAX_FILES);
  if (selected.length === 0) return;

  workspace.hidden = false;
  statusElement.textContent = `Inspecting ${selected.length} ${pluralize(selected.length, 'file')}…`;

  if (fileList.length > MAX_FILES) {
    statusElement.textContent = `Only the first ${MAX_FILES} files will be inspected.`;
  }

  let completed = 0;
  for (const file of selected) {
    const shell = createLoadingCard(file);
    resultsElement.append(shell.card);

    if (file.size > MAX_FILE_BYTES) {
      const report = createRejectedReport(file, `File exceeds the ${formatBytes(MAX_FILE_BYTES)} limit.`);
      reports.push(report);
      renderReport(shell.card, file, report);
    } else {
      try {
        const report = await inspectFile(file);
        reports.push(report);
        renderReport(shell.card, file, report);
      } catch (error) {
        const report = createRejectedReport(file, errorMessage(error));
        reports.push(report);
        renderReport(shell.card, file, report);
      }
    }

    completed += 1;
    statusElement.textContent = `Inspected ${completed} of ${selected.length} ${pluralize(selected.length, 'file')}.`;
  }

  copyButton.disabled = reports.length === 0;
  downloadButton.disabled = reports.length === 0;
}

async function inspectFile(file) {
  const startedAt = performance.now();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const detected = detectFileType(bytes, file.type, file.name);

  const [sha256, dimensions, standardMetadata, c2pa] = await Promise.all([
    calculateSha256(buffer),
    readDisplayedDimensions(file),
    readStandardMetadata(buffer),
    readC2pa(file, detected.mime),
  ]);

  const container = inspectContainer(bytes, detected.kind);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    processingMilliseconds: Math.round((performance.now() - startedAt) * 10) / 10,
    file: {
      name: file.name,
      sizeBytes: file.size,
      browserMimeType: file.type || null,
      detectedMimeType: detected.mime,
      detectedFormat: detected.label,
      lastModified: Number.isFinite(file.lastModified)
        ? new Date(file.lastModified).toISOString()
        : null,
      sha256,
      width: dimensions.width,
      height: dimensions.height,
      previewSupported: dimensions.supported,
    },
    container,
    standardMetadata,
    c2pa,
  };
}

async function readStandardMetadata(buffer) {
  try {
    const tags = await ExifReader.load(buffer, {
      expanded: true,
      async: true,
      computed: true,
      includeUnknown: true,
      includeOffsets: true,
    });

    return {
      status: 'read',
      groups: normalizeForReport(tags),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      error: errorMessage(error),
      groups: {},
    };
  }
}

async function readC2pa(file, detectedMime) {
  let reader;
  try {
    const sdk = await getC2paSdk();
    const format = c2paFormatFor(file, detectedMime);
    reader = await sdk.reader.fromBlob(format, file);

    if (!reader) {
      return {
        status: 'not-found',
        formatUsed: format,
        manifestStore: null,
      };
    }

    const manifestStore = await reader.manifestStore();
    let crJson = null;
    let crJsonError = null;

    try {
      crJson = await reader.crJson();
    } catch (error) {
      crJsonError = errorMessage(error);
    }

    return {
      status: 'found',
      formatUsed: format,
      manifestStore: normalizeForReport(manifestStore),
      crJson: normalizeForReport(crJson),
      crJsonError,
    };
  } catch (error) {
    return {
      status: 'error',
      formatUsed: c2paFormatFor(file, detectedMime),
      error: errorMessage(error),
      manifestStore: null,
    };
  } finally {
    if (reader) {
      try {
        await reader.free();
      } catch {
        // Releasing WASM memory should not replace an otherwise useful report.
      }
    }
  }
}

function getC2paSdk() {
  if (!c2paSdkPromise) {
    c2paSdkPromise = createC2pa({ wasmSrc }).catch((error) => {
      c2paSdkPromise = undefined;
      throw error;
    });
  }
  return c2paSdkPromise;
}

function c2paFormatFor(file, detectedMime) {
  if (detectedMime && detectedMime !== 'application/octet-stream') return detectedMime;
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  return extension || 'application/octet-stream';
}

async function calculateSha256(buffer) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readDisplayedDimensions(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const result = {
        width: image.naturalWidth || null,
        height: image.naturalHeight || null,
        supported: true,
      };
      URL.revokeObjectURL(url);
      resolve(result);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: null, height: null, supported: false });
    };

    image.src = url;
  });
}

function detectFileType(bytes, browserType, fileName) {
  const ascii = (start, length) =>
    String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + length)));

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'jpeg', mime: 'image/jpeg', label: 'JPEG' };
  }
  if (bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
    return { kind: 'png', mime: 'image/png', label: 'PNG' };
  }
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    return { kind: 'gif', mime: 'image/gif', label: 'GIF' };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    return { kind: 'webp', mime: 'image/webp', label: 'WebP' };
  }
  if (
    (ascii(0, 2) === 'II' && bytes[2] === 42 && bytes[3] === 0) ||
    (ascii(0, 2) === 'MM' && bytes[2] === 0 && bytes[3] === 42)
  ) {
    return { kind: 'tiff', mime: 'image/tiff', label: 'TIFF' };
  }
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4).toLowerCase();
    if (brand.startsWith('avif') || brand.startsWith('avis')) {
      return { kind: 'isobmff', mime: 'image/avif', label: `AVIF (${brand})` };
    }
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) {
      return { kind: 'isobmff', mime: 'image/heic', label: `HEIC (${brand})` };
    }
    if (['mif1', 'msf1', 'heif'].includes(brand)) {
      return { kind: 'isobmff', mime: 'image/heif', label: `HEIF (${brand})` };
    }
    return { kind: 'isobmff', mime: browserType || 'application/mp4', label: `ISO BMFF (${brand})` };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a) {
    return { kind: 'jxl', mime: 'image/jxl', label: 'JPEG XL' };
  }
  if (ascii(0, 5) === '%PDF-') {
    return { kind: 'generic', mime: 'application/pdf', label: 'PDF' };
  }

  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  return {
    kind: 'generic',
    mime: browserType || mimeFromExtension(extension) || 'application/octet-stream',
    label: browserType || extension.toUpperCase() || 'Unknown',
  };
}

function mimeFromExtension(extension) {
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
    avif: 'image/avif',
    jxl: 'image/jxl',
    dng: 'image/dng',
  };
  return map[extension] || null;
}

function inspectContainer(bytes, kind) {
  try {
    switch (kind) {
      case 'jpeg':
        return { format: 'JPEG', structures: inspectJpeg(bytes) };
      case 'png':
        return { format: 'PNG', structures: inspectPng(bytes) };
      case 'webp':
        return { format: 'WebP', structures: inspectRiff(bytes) };
      case 'isobmff':
        return { format: 'ISO BMFF', structures: inspectIsoBmff(bytes) };
      default:
        return { format: kind.toUpperCase(), structures: [] };
    }
  } catch (error) {
    return { format: kind.toUpperCase(), structures: [], error: errorMessage(error) };
  }
}

function inspectJpeg(bytes) {
  const markerNames = {
    0xe0: 'APP0', 0xe1: 'APP1', 0xe2: 'APP2', 0xe3: 'APP3',
    0xe4: 'APP4', 0xe5: 'APP5', 0xe6: 'APP6', 0xe7: 'APP7',
    0xe8: 'APP8', 0xe9: 'APP9', 0xea: 'APP10', 0xeb: 'APP11',
    0xec: 'APP12', 0xed: 'APP13', 0xee: 'APP14', 0xef: 'APP15',
    0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc4: 'DHT',
    0xdb: 'DQT', 0xdd: 'DRI', 0xda: 'SOS', 0xfe: 'COM',
  };
  const structures = [{ offset: 0, type: 'SOI', sizeBytes: 2, identifier: 'JPEG start' }];
  let offset = 2;

  while (offset + 4 <= bytes.length && structures.length < 1_000) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    const markerOffset = offset - 1;
    offset += 1;

    if (marker === 0xd9) {
      structures.push({ offset: markerOffset, type: 'EOI', sizeBytes: 2, identifier: 'JPEG end' });
      break;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;

    const length = readUint16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    const payloadStart = offset + 2;
    const payloadLength = length - 2;
    const type = markerNames[marker] || `FF${marker.toString(16).toUpperCase().padStart(2, '0')}`;
    structures.push({
      offset: markerOffset,
      type,
      sizeBytes: length + 2,
      payloadBytes: payloadLength,
      identifier: jpegIdentifier(bytes, payloadStart, payloadLength),
    });
    offset += length;

    if (marker === 0xda) {
      structures.push({
        offset,
        type: 'Image data',
        sizeBytes: Math.max(0, bytes.length - offset - 2),
        identifier: 'Entropy-coded pixel data',
      });
      break;
    }
  }
  return structures;
}

function jpegIdentifier(bytes, start, length) {
  const sample = bytes.subarray(start, Math.min(start + length, start + 96));
  const text = printableIdentifier(sample);
  if (text) return text;
  if (length >= 4) return `Hex ${hexPreview(sample, 16)}`;
  return null;
}

function inspectPng(bytes) {
  const structures = [{ offset: 0, type: 'Signature', sizeBytes: 8, identifier: 'PNG signature' }];
  let offset = 8;
  while (offset + 12 <= bytes.length && structures.length < 1_000) {
    const length = readUint32(bytes, offset);
    const type = asciiAt(bytes, offset + 4, 4);
    const total = length + 12;
    if (offset + total > bytes.length) break;
    const payload = bytes.subarray(offset + 8, offset + 8 + Math.min(length, 96));
    structures.push({
      offset,
      type,
      sizeBytes: total,
      payloadBytes: length,
      identifier: ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)
        ? printableIdentifier(payload)
        : null,
    });
    offset += total;
    if (type === 'IEND') break;
  }
  return structures;
}

function inspectRiff(bytes) {
  const structures = [{ offset: 0, type: 'RIFF', sizeBytes: bytes.length, identifier: asciiAt(bytes, 8, 4) }];
  let offset = 12;
  while (offset + 8 <= bytes.length && structures.length < 1_000) {
    const type = asciiAt(bytes, offset, 4);
    const length = readUint32LE(bytes, offset + 4);
    structures.push({ offset, type, sizeBytes: length + 8, payloadBytes: length, identifier: null });
    offset += 8 + length + (length % 2);
  }
  return structures;
}

function inspectIsoBmff(bytes) {
  const structures = [];
  let offset = 0;
  while (offset + 8 <= bytes.length && structures.length < 1_000) {
    let size = readUint32(bytes, offset);
    const type = asciiAt(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1 && offset + 16 <= bytes.length) {
      const high = readUint32(bytes, offset + 8);
      const low = readUint32(bytes, offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || offset + size > bytes.length) break;
    structures.push({
      offset,
      type,
      sizeBytes: size,
      payloadBytes: size - headerSize,
      identifier: type === 'ftyp' ? printableIdentifier(bytes.subarray(offset + headerSize, Math.min(offset + size, offset + 96))) : null,
    });
    offset += size;
  }
  return structures;
}

function printableIdentifier(bytes) {
  let output = '';
  for (const byte of bytes) {
    if (byte === 0) {
      if (output.length >= 4) break;
      continue;
    }
    if (byte >= 32 && byte <= 126) output += String.fromCharCode(byte);
    else if (output.length >= 4) break;
    else output = '';
    if (output.length >= 72) break;
  }
  return output.length >= 4 ? output : null;
}

function asciiAt(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16(bytes, offset) {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] * 2 ** 24 +
    bytes[offset + 1] * 2 ** 16 +
    bytes[offset + 2] * 2 ** 8 +
    bytes[offset + 3]
  ) >>> 0;
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] +
    bytes[offset + 1] * 2 ** 8 +
    bytes[offset + 2] * 2 ** 16 +
    bytes[offset + 3] * 2 ** 24
  ) >>> 0;
}

function normalizeForReport(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}\n… [truncated ${value.length - MAX_STRING_LENGTH} characters]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (depth >= MAX_DEPTH) return '[maximum display depth reached]';

  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return binarySummary(bytes, 'ArrayBuffer');
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return binarySummary(bytes, value.constructor?.name || 'TypedArray');
  }
  if (value instanceof Blob) {
    return { _type: value.constructor?.name || 'Blob', sizeBytes: value.size, mimeType: value.type || null };
  }
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular reference]';
    seen.add(value);

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeForReport(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[${value.length - MAX_ARRAY_ITEMS} additional items omitted]`);
      }
      seen.delete(value);
      return items;
    }

    const output = Object.create(null);
    const entries = Object.entries(value);
    for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
      output[key] = normalizeForReport(child, depth + 1, seen);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      output._omittedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    seen.delete(value);
    return output;
  }

  return String(value);
}

function binarySummary(bytes, type) {
  return {
    _type: type,
    lengthBytes: bytes.byteLength,
    hexPreview: hexPreview(bytes, 48),
  };
}

function hexPreview(bytes, limit) {
  const selected = bytes.subarray(0, Math.min(bytes.length, limit));
  const text = Array.from(selected, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
  return bytes.length > limit ? `${text} …` : text;
}

function createLoadingCard(file) {
  const card = element('article', 'report-card');
  card.setAttribute('aria-busy', 'true');
  const shell = element('div', 'loading-shell');
  shell.append(
    element('div', 'loading-line'),
    element('div', 'loading-line'),
    element('div', 'loading-line'),
  );
  card.append(shell);
  card.dataset.fileName = file.name;
  return { card };
}

function renderReport(card, file, report) {
  card.replaceChildren();
  card.removeAttribute('aria-busy');

  const header = element('div', 'report-header');
  const preview = element('div', 'preview-frame');
  const image = document.createElement('img');
  const previewUrl = URL.createObjectURL(file);
  image.alt = '';
  image.src = previewUrl;
  image.onload = () => URL.revokeObjectURL(previewUrl);
  image.onerror = () => {
    URL.revokeObjectURL(previewUrl);
    preview.replaceChildren(element('span', 'preview-fallback', report.file?.detectedFormat || 'No preview'));
  };
  preview.append(image);

  const headingWrap = element('div');
  const headingRow = element('div', 'report-heading-row');
  const headingText = element('div');
  headingText.append(
    element('h3', 'report-title', file.name),
    element('p', 'report-subtitle', `${formatBytes(file.size)} · ${report.file?.detectedFormat || file.type || 'Unknown format'}`),
  );
  headingRow.append(headingText, reportStatusChip(report));
  headingWrap.append(headingRow);
  header.append(preview, headingWrap);

  const body = element('div', 'report-body');
  if (report.status === 'rejected') {
    body.append(element('p', 'error-message', report.error));
  } else {
    body.append(
      renderSummary(report),
      renderFileSection(report),
      renderC2paSection(report.c2pa),
      renderStandardMetadataSection(report.standardMetadata),
      renderContainerSection(report.container),
      renderRawSection(report),
    );
  }

  card.append(header, body);
}

function reportStatusChip(report) {
  if (report.status === 'rejected') return element('span', 'status-chip danger', 'Could not inspect');
  if (report.c2pa?.status === 'found') {
    const state = c2paValidationState(report.c2pa.manifestStore);
    return element('span', `status-chip ${state === 'Invalid' ? 'danger' : ''}`.trim(), `C2PA: ${state}`);
  }
  if (report.c2pa?.status === 'error') return element('span', 'status-chip warning', 'C2PA unreadable');
  return element('span', 'status-chip neutral', 'No C2PA found');
}

function renderSummary(report) {
  const grid = element('div', 'summary-grid');
  const dimensions = report.file.width && report.file.height
    ? `${report.file.width} × ${report.file.height}`
    : 'Not decoded';
  const metadataCount = countMetadataTags(report.standardMetadata?.groups || {});
  const c2paText = report.c2pa.status === 'found'
    ? c2paValidationState(report.c2pa.manifestStore)
    : report.c2pa.status === 'not-found' ? 'Not found' : 'Unavailable';

  grid.append(
    summaryItem('Format', report.file.detectedFormat),
    summaryItem('Dimensions', dimensions),
    summaryItem('Metadata entries', String(metadataCount)),
    summaryItem('C2PA', c2paText),
  );
  return grid;
}

function summaryItem(label, value) {
  const item = element('div', 'summary-item');
  item.append(element('span', 'summary-label', label), element('span', 'summary-value', value || '—'));
  return item;
}

function renderFileSection(report) {
  const rows = [
    { key: 'Filename', description: report.file.name, raw: null },
    { key: 'File size', description: formatBytes(report.file.sizeBytes), raw: `${report.file.sizeBytes} bytes` },
    { key: 'Detected MIME type', description: report.file.detectedMimeType, raw: null },
    { key: 'Browser MIME type', description: report.file.browserMimeType || 'Not supplied', raw: null },
    { key: 'Last modified', description: formatDate(report.file.lastModified), raw: report.file.lastModified },
    { key: 'SHA-256', description: report.file.sha256 || 'Unavailable', raw: null },
    { key: 'Processing time', description: `${report.processingMilliseconds} ms`, raw: null },
  ];
  return detailsSection('File information', rows.length, renderRows(rows), true);
}

function renderC2paSection(c2pa) {
  const wrapper = element('div');
  if (c2pa.status === 'found') {
    const store = c2pa.manifestStore || {};
    const rows = [
      { key: 'Status', description: 'C2PA manifest found', raw: null },
      { key: 'Validation state', description: c2paValidationState(store), raw: null },
      { key: 'Active manifest', description: store.active_manifest || store.activeManifest || 'Not reported', raw: null },
      { key: 'Format supplied to parser', description: c2pa.formatUsed, raw: null },
    ];
    wrapper.append(
      renderRows(rows),
      element('p', 'section-note', 'Complete parsed manifest store:'),
      codeBlock(store),
    );
    if (c2pa.crJson) {
      const crDetails = document.createElement('details');
      crDetails.className = 'inspection-section';
      const summary = document.createElement('summary');
      summary.append(element('span', 'summary-title', 'Content Credentials JSON (crJSON)'));
      const content = element('div', 'section-content');
      content.append(codeBlock(c2pa.crJson));
      crDetails.append(summary, content);
      wrapper.append(crDetails);
    }
    if (c2pa.crJsonError) wrapper.append(element('p', 'error-message', `crJSON could not be produced: ${c2pa.crJsonError}`));
  } else if (c2pa.status === 'not-found') {
    wrapper.append(element('p', 'empty-message', 'No C2PA manifest was found in this file. This is not an authenticity assessment.'));
  } else {
    wrapper.append(element('p', 'error-message', `C2PA inspection failed: ${c2pa.error || 'Unknown error'}`));
  }
  return detailsSection('C2PA Content Credentials', c2pa.status === 'found' ? 1 : 0, wrapper, true);
}

function renderStandardMetadataSection(metadata) {
  const wrapper = element('div');
  const groups = metadata?.groups || {};
  const entries = Object.entries(groups).sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b));

  if (metadata?.status !== 'read') {
    wrapper.append(element('p', 'error-message', `Standard metadata could not be read: ${metadata?.error || 'Unknown error'}`));
  } else if (entries.length === 0) {
    wrapper.append(element('p', 'empty-message', 'The metadata parser returned no standard metadata groups.'));
  } else {
    for (const [groupName, groupValue] of entries) {
      const rows = flattenMetadata(groupValue);
      wrapper.append(detailsSection(prettyGroupName(groupName), rows.length, renderRows(rows), false));
    }
  }
  return detailsSection('EXIF, XMP, IPTC, ICC and related metadata', countMetadataTags(groups), wrapper, true);
}

function renderContainerSection(container) {
  const rows = (container?.structures || []).map((item) => ({
    key: item.type,
    description: item.identifier || '—',
    raw: `offset ${item.offset}; ${item.sizeBytes} bytes${item.payloadBytes === undefined ? '' : `; payload ${item.payloadBytes} bytes`}`,
  }));
  const wrapper = element('div');
  wrapper.append(element('p', 'section-note', `Parsed top-level ${container?.format || 'file'} structures. Binary pixel data is measured but not displayed.`));
  if (container?.error) wrapper.append(element('p', 'error-message', container.error));
  if (rows.length) wrapper.append(renderRows(rows));
  else wrapper.append(element('p', 'empty-message', 'No container inventory is available for this format.'));
  return detailsSection('File container structure', rows.length, wrapper, false);
}

function renderRawSection(report) {
  const wrapper = element('div');
  wrapper.append(
    element('p', 'section-note', 'Share this structured report to compare what different devices and save paths preserve.'),
    codeBlock(report),
  );
  return detailsSection('Complete JSON report', null, wrapper, false);
}

function detailsSection(title, count, content, open) {
  const details = document.createElement('details');
  details.className = 'inspection-section';
  details.open = Boolean(open);

  const summary = document.createElement('summary');
  const titleWrap = element('span', 'summary-title');
  titleWrap.append(element('span', '', title));
  if (Number.isFinite(count)) titleWrap.append(element('span', 'count-badge', String(count)));
  summary.append(titleWrap);

  const sectionContent = element('div', 'section-content');
  sectionContent.append(content);
  details.append(summary, sectionContent);
  return details;
}

function renderRows(rows) {
  const table = element('div', 'metadata-table');
  table.setAttribute('role', 'table');
  const header = element('div', 'metadata-row header');
  header.setAttribute('role', 'row');
  header.append(cell('Field', 'Field', 'columnheader'), cell('Readable value', 'Readable value', 'columnheader'), cell('Stored/raw value', 'Stored/raw value', 'columnheader'));
  table.append(header);

  for (const row of rows) {
    const rowElement = element('div', 'metadata-row');
    rowElement.setAttribute('role', 'row');
    rowElement.append(
      cell(row.key || 'Value', 'Field', 'cell', 'metadata-key'),
      cell(displayValue(row.description), 'Readable value'),
      cell(displayValue(row.raw), 'Stored/raw value', 'cell', 'metadata-raw'),
    );
    table.append(rowElement);
  }
  return table;
}

function cell(value, label, role = 'cell', extraClass = '') {
  const item = element('div', `metadata-cell ${extraClass}`.trim(), value);
  item.dataset.label = label;
  item.setAttribute('role', role);
  return item;
}

function flattenMetadata(value, path = '', rows = [], depth = 0) {
  if (rows.length >= MAX_OBJECT_KEYS || depth >= MAX_DEPTH) return rows;

  if (isTagObject(value)) {
    const keys = Object.keys(value);
    const auxiliary = Object.create(null);
    for (const key of keys) {
      if (!['description', 'value'].includes(key)) auxiliary[key] = value[key];
    }
    rows.push({
      key: path || 'Value',
      description: Object.prototype.hasOwnProperty.call(value, 'description') ? value.description : value.value,
      raw: Object.prototype.hasOwnProperty.call(value, 'value')
        ? value.value
        : Object.keys(auxiliary).length ? auxiliary : null,
    });
    return rows;
  }

  if (Array.isArray(value)) {
    value.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => {
      flattenMetadata(item, `${path}[${index}]`, rows, depth + 1);
    });
    return rows;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) rows.push({ key: path || 'Value', description: '{}', raw: null });
    for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
      flattenMetadata(child, path ? `${path}.${key}` : key, rows, depth + 1);
    }
    return rows;
  }

  rows.push({ key: path || 'Value', description: value, raw: null });
  return rows;
}

function isTagObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.prototype.hasOwnProperty.call(value, 'description') ||
      Object.prototype.hasOwnProperty.call(value, 'value')),
  );
}

function countMetadataTags(groups) {
  return Object.values(groups || {}).reduce((total, group) => total + flattenMetadata(group).length, 0);
}

function groupRank(name) {
  const order = ['file', 'jfif', 'exif', 'gps', 'iptc', 'xmp', 'icc', 'photoshop', 'makerNotes', 'mpf', 'pngFile', 'pngText', 'riff', 'gif', 'composite', 'Thumbnail'];
  const index = order.indexOf(name);
  return index === -1 ? 1_000 : index;
}

function prettyGroupName(name) {
  const known = {
    file: 'File', jfif: 'JFIF', exif: 'EXIF', gps: 'GPS', iptc: 'IPTC',
    xmp: 'XMP', icc: 'ICC profile', photoshop: 'Photoshop resources',
    makerNotes: 'Maker notes', mpf: 'MPF', pngFile: 'PNG file',
    pngText: 'PNG text', riff: 'RIFF / WebP', gif: 'GIF',
    composite: 'Computed values', Thumbnail: 'Embedded thumbnail',
  };
  return known[name] || name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function c2paValidationState(store) {
  return store?.validation_state || store?.validationState || (store ? 'Manifest present' : 'Unknown');
}

function codeBlock(value) {
  const pre = element('pre', 'code-block');
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createRejectedReport(file, error) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'rejected',
    error,
    file: {
      name: file.name,
      sizeBytes: file.size,
      browserMimeType: file.type || null,
    },
  };
}

function clearResults() {
  reports = [];
  resultsElement.replaceChildren();
  statusElement.textContent = '';
  workspace.hidden = true;
  copyButton.disabled = true;
  downloadButton.disabled = true;
}

async function copyReports() {
  const json = JSON.stringify(exportPayload(), null, 2);
  const original = copyButton.textContent;
  try {
    await copyText(json);
    copyButton.textContent = 'Copied';
  } catch {
    copyButton.textContent = 'Copy failed';
  } finally {
    setTimeout(() => {
      copyButton.textContent = original;
    }, 1_600);
  }
}

function downloadReports() {
  const blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `photo-metadata-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function exportPayload() {
  return {
    reportFormat: 'photo-metadata-explorer',
    reportVersion: 1,
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    reports,
  };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy command was rejected');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 bytes';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 2 })} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return 'Not supplied';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function pluralize(count, word) {
  return count === 1 ? word : `${word}s`;
}

function errorMessage(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : 'Unknown error';
}

function element(tagName, className = '', text = null) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}
