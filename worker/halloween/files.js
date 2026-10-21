// Downloads a file that ChatGPT hands to a tool ({ download_url, file_id }).
// Only HTTPS URLs on hosts used for ChatGPT file storage are fetched, every redirect
// hop is checked again, and the body is read with a hard size limit.

// Host suffixes observed for ChatGPT file downloads (some go through cloud blob storage).
export const DEFAULT_FILE_HOSTS = [
  "oaiusercontent.com",
  "openaiusercontent.com",
  "chatgptusercontent.com",
  "openai.com",
  "chatgpt.com",
  "blob.core.windows.net",
];

export class FileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FileError";
    this.code = code;
  }
}

export function allowedHost(url, hosts = DEFAULT_FILE_HOSTS) {
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isFileParam(value) {
  return Boolean(value && typeof value === "object" && typeof value.download_url === "string" && value.download_url.length < 4096);
}

export async function downloadFile(file, { label, maxBytes, hosts = DEFAULT_FILE_HOSTS, fetchImpl = fetch } = {}) {
  if (!isFileParam(file)) throw new FileError("bad_file", `${label}: expected a file from ChatGPT`);
  let url;
  try {
    url = new URL(file.download_url);
  } catch {
    throw new FileError("bad_file", `${label}: download URL is not valid`);
  }
  for (let hop = 0; hop <= 3; hop++) {
    if (!allowedHost(url, hosts)) throw new FileError("host_not_allowed", `${label}: files from ${url.hostname} are not accepted`);
    const response = await fetchImpl(url.toString(), { redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new FileError("download_failed", `${label}: redirect without a location`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw new FileError("download_failed", `${label}: download returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new FileError("too_large", `${label}: larger than ${maxBytes} bytes`);
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FileError("too_large", `${label}: larger than ${maxBytes} bytes`);
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.byteLength;
    }
    return bytes;
  }
  throw new FileError("download_failed", `${label}: too many redirects`);
}
