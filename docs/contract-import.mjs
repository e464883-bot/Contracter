const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 250_000;
const MAX_PDF_PAGES = 120;
const PDFJS_DIRECTORY = "./vendor/pdfjs-6.5.438/";
const OFFICE_DOCUMENT_RELATIONSHIP = "/officeDocument";
const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);

class ContractImportError extends Error {}

function check(condition, message) {
  if (!condition) throw new ContractImportError(message);
}

function textCollector() {
  const parts = [];
  let length = 0;
  return {
    append(text) {
      length += text.length;
      check(length <= MAX_TEXT_LENGTH, "El documento contiene más de 250 000 caracteres. Divídelo antes de abrirlo.");
      parts.push(text);
    },
    read() {
      return parts.join("").replace(/\r\n?|[\u000b\u000c\u0085]/g, "\n")
        .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
        .replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    },
  };
}

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = "El archivo .docx no es un documento de Word válido.";
  const word = (offset) => view.getUint16(offset, true);
  const dword = (offset) => view.getUint32(offset, true);
  const minimum = Math.max(0, bytes.length - 65_557);
  let end = bytes.length - 22;
  while (end >= minimum && (dword(end) !== 0x06054b50 || end + 22 + word(end + 20) !== bytes.length)) end--;
  check(end >= minimum, invalid);
  const count = word(end + 10);
  const directoryStart = dword(end + 16);
  const directoryEnd = directoryStart + dword(end + 12);
  check(word(end + 4) === 0 && word(end + 6) === 0 && word(end + 8) === count
    && count > 0 && count <= 4096 && directoryEnd <= end, invalid);

  const decoder = new TextDecoder();
  const entries = new Map();
  let cursor = directoryStart;
  for (let i = 0; i < count; i++) {
    check(cursor + 46 <= directoryEnd && dword(cursor) === 0x02014b50, invalid);
    const offset = dword(cursor + 42);
    const nameLength = word(cursor + 28);
    const nameEnd = cursor + 46 + nameLength;
    const afterEntry = nameEnd + word(cursor + 30) + word(cursor + 32);
    check(nameLength > 0 && afterEntry <= directoryEnd && word(cursor + 34) === 0, invalid);
    const rawName = bytes.subarray(cursor + 46, nameEnd);
    const name = decoder.decode(rawName);
    check(!entries.has(name), invalid);
    entries.set(name, {
      offset, rawName, flags: word(cursor + 8), method: word(cursor + 10),
      crc: dword(cursor + 16), compressed: dword(cursor + 20), size: dword(cursor + 24),
    });
    cursor = afterEntry;
  }

  async function readPart(name) {
    const entry = entries.get(name);
    check(entry, invalid);
    check(entry.size <= MAX_XML_BYTES, "El contenido interno de Word es demasiado grande. Divide el documento antes de abrirlo.");
    const { offset, flags, method } = entry;
    check((flags & 0x2041) === 0 && (method === 0 || method === 8), "El archivo Word está protegido o usa una compresión no compatible.");
    check(offset + 30 <= directoryStart && dword(offset) === 0x04034b50
      && word(offset + 6) === flags && word(offset + 8) === method, invalid);
    const nameStart = offset + 30;
    const nameEnd = nameStart + word(offset + 26);
    const dataStart = nameEnd + word(offset + 28);
    check(dataStart + entry.compressed <= directoryStart && nameEnd - nameStart === entry.rawName.length
      && entry.rawName.every((byte, index) => byte === bytes[nameStart + index]), invalid);
    const data = bytes.subarray(dataStart, dataStart + entry.compressed);
    const expanded = method === 0 ? data : await readDeflate(data, entry.size, invalid);
    check(expanded.length === entry.size && crc32(expanded) === entry.crc, invalid);
    return expanded;
  }

  return { readPart };
}

async function readDeflate(bytes, length, invalid) {
  let reader;
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  } catch {
    throw new ContractImportError("Tu navegador no admite la descompresión de Word. Usa una versión reciente de Edge, Chrome o Firefox.");
  }
  const result = new Uint8Array(length);
  let cursor = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      check(cursor + value.length <= length, invalid);
      result.set(value, cursor);
      cursor += value.length;
    }
    check(cursor === length, invalid);
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, initialValue) => {
  let value = initialValue;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function parseWordXml(bytes) {
  const encoding = bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c
    ? "utf-16be"
    : (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0) ? "utf-16le" : "utf-8";
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  check(!/<!\s*(?:doctype|entity)\b/i.test(source), "El archivo Word contiene una declaración XML no compatible.");
  const xml = new DOMParser().parseFromString(source, "application/xml");
  check(xml.documentElement && !xml.getElementsByTagNameNS("*", "parsererror").length,
    "El contenido interno del archivo Word está dañado.");
  return xml;
}

async function extractWord(bytes) {
  const zip = readZipEntries(bytes);
  const links = parseWordXml(await zip.readPart("_rels/.rels"));
  const wordPart = [...links.getElementsByTagNameNS("*", "Relationship")].find((relation) =>
    relation.getAttribute("Type")?.endsWith(OFFICE_DOCUMENT_RELATIONSHIP));
  const target = wordPart?.getAttribute("Target") || "";
  const name = target.replace(/^\//, "");
  check(wordPart?.getAttribute("TargetMode") !== "External" && name && !/[:\\?#]/.test(name)
    && name.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
  "El archivo de Word no identifica su documento principal.");
  const xml = parseWordXml(await zip.readPart(name));
  const body = [...xml.documentElement.children].find((child) =>
    child.localName === "body" && WORD_NAMESPACES.has(child.namespaceURI));
  check(xml.documentElement.localName === "document" && body, "El archivo Word no tiene un cuerpo de texto legible.");

  const text = textCollector();
  const walker = xml.createTreeWalker(body, NodeFilter.SHOW_ELEMENT, { acceptNode(node) {
    return WORD_NAMESPACES.has(node.namespaceURI) && ["del", "moveFrom"].includes(node.localName)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
  } });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!WORD_NAMESPACES.has(node.namespaceURI)) continue;
    switch (node.localName) {
      case "p": case "br": case "cr": text.append("\n"); break;
      case "t": text.append(node.textContent); break;
      case "tab": text.append("\t"); break;
      case "noBreakHyphen": text.append("-"); break;
    }
  }
  return text.read();
}

async function extractPdf(bytes) {
  let pdfjs;
  try {
    pdfjs = await import(PDFJS_DIRECTORY + "pdf.min.mjs");
  } catch {
    throw new ContractImportError("No se pudo cargar el lector PDF. Abre Contracter desde su dirección web local o publicada.");
  }
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(PDFJS_DIRECTORY + "pdf.worker.min.mjs", import.meta.url).href;
  const task = pdfjs.getDocument({
    data: bytes, disableFontFace: true, useSystemFonts: true, useWasm: false,
    enableXfa: false, stopAtErrors: true, verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    check(pdf.numPages <= MAX_PDF_PAGES, "El PDF tiene más de 120 páginas. Divídelo antes de abrirlo.");
    const documentText = textCollector();
    const emptyPages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      const pageText = textCollector();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== "string") continue;
            pageText.append(item.str);
            if (item.hasEOL) pageText.append("\n");
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      const section = pageText.read();
      if (section) documentText.append(section + "\n\n");
      else emptyPages.push(pageNumber);
    }
    return { text: documentText.read(), emptyPages };
  } catch (error) {
    if (error instanceof ContractImportError) throw error;
    if (error?.name === "PasswordException") throw new ContractImportError("El PDF está protegido con contraseña. Exporta una copia desbloqueada antes de abrirlo.");
    throw new ContractImportError("No se pudo leer el PDF. Comprueba que se abre en tu lector y que contiene texto seleccionable.");
  } finally {
    await task.destroy().catch(() => {});
  }
}

export async function extractContractDocument(file) {
  const format = String(file?.name || "").split(".").at(-1).toLowerCase();
  check(format === "docx" || format === "pdf", "Elige un PDF o un Word .docx. Para un .doc antiguo, guarda primero una copia en .docx.");
  check(Number.isSafeInteger(file.size) && file.size > 0, "El archivo está vacío.");
  check(file.size <= MAX_FILE_BYTES, "El archivo supera 20 MB. Guarda una copia más pequeña antes de abrirlo.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  check(bytes.length === file.size, "El archivo cambió mientras se estaba leyendo. Vuelve a seleccionarlo.");
  try {
    const result = format === "pdf" ? await extractPdf(bytes) : { text: await extractWord(bytes) };
    check(result.text, format === "pdf"
      ? "El PDF no contiene texto seleccionable. Si es una imagen escaneada, aplica reconocimiento de texto (OCR) y vuelve a abrirlo."
      : "El Word no contiene texto en el cuerpo del documento.");
    return { format, ...result };
  } catch (error) {
    if (error instanceof ContractImportError) throw error;
    throw new ContractImportError("No se pudo leer el documento. Comprueba que el archivo está completo y vuelve a abrirlo.");
  }
}
