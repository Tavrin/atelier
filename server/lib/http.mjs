const MAX_BODY_BYTES = 256 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export function textResponse(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

export function readJsonBody(request) {
  // Requiring the JSON content type forces cross-origin browser POSTs into a
  // CORS preflight (which this server never answers), closing the CSRF hole a
  // hostile webpage would otherwise have against the loopback port.
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new HttpError(413, "Request body is too large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("JSON body must be an object");
        }
        resolvePromise(parsed);
      } catch (error) {
        rejectPromise(new HttpError(400, `Invalid JSON body: ${error.message}`));
      }
    });

    request.on("error", (error) => rejectPromise(new HttpError(400, error.message)));
  });
}

export function requiredString(body, key) {
  if (typeof body[key] !== "string" || !body[key].trim()) {
    throw new HttpError(400, `${key} must be a non-empty string`);
  }
  const value = body[key].trim();
  // Leading-dash values would be parsed by br's argument parser as flags
  // (e.g. comment text "-f/etc/hostname" becomes a file-read flag).
  if (value.startsWith("-")) {
    throw new HttpError(400, `${key} must not start with "-"`);
  }
  return value;
}

export function optionalString(body, key) {
  if (body[key] === undefined || body[key] === null || body[key] === "") return undefined;
  if (typeof body[key] !== "string") throw new HttpError(400, `${key} must be a string`);
  const value = body[key].trim();
  if (value.startsWith("-")) {
    throw new HttpError(400, `${key} must not start with "-"`);
  }
  return value;
}

export function parsePriority(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toUpperCase().replace(/^P/, "");
  if (!/^[0-4]$/.test(normalized)) {
    throw new HttpError(400, "priority must be between 0 and 4");
  }
  return normalized;
}
