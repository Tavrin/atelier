import { readFileSync } from "node:fs";
import { join } from "node:path";

import { liveInstanceOwner } from "./instance-lock.mjs";
import { stateDir } from "./paths.mjs";

function loopbackUrl(value, source) {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(value);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be an http://127.0.0.1:<port> URL`);
  }
  return `http://127.0.0.1:${port}`;
}

export function atelierServerUrl({ directory = stateDir(), env = process.env } = {}) {
  if (env.PORT !== undefined) {
    const port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("PORT must be an integer between 1 and 65535");
    }
    return `http://127.0.0.1:${port}`;
  }
  const urlPath = join(directory, "atelier.url");
  try {
    return loopbackUrl(readFileSync(urlPath, "utf8").trim(), urlPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return "http://127.0.0.1:5170";
}

export class CommandClientError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "CommandClientError";
    this.status = status;
  }
}

async function responseJson(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new CommandClientError(
      body.error || `Atelier server returned HTTP ${response.status}`,
      { status: response.status },
    );
  }
  return body;
}

async function fetchDaemon(baseUrl, directory, path, options = {}) {
  try {
    return await fetch(`${baseUrl}${path}`, options);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    const owner = liveInstanceOwner(directory);
    if (owner === undefined) {
      throw new CommandClientError(
        "no daemon; start it with `atelier serve` / systemctl --user start atelier",
      );
    }
    throw new CommandClientError(
      `a daemon (PID ${owner}) owns this state dir but is not reachable at ${baseUrl}`,
    );
  }
}

async function latestEventSeq(baseUrl, directory, id) {
  const controller = new AbortController();
  try {
    const response = await fetchDaemon(
      baseUrl,
      directory,
      `/api/dispatch/${encodeURIComponent(id)}/events`,
      { headers: { Accept: "text/event-stream" }, signal: controller.signal },
    );
    if (!response.ok) {
      await responseJson(response);
      return 0;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.includes(": heartbeat\n\n")) break;
    }
    return [...buffer.matchAll(/^id: (\d+)$/gm)]
      .reduce((highest, match) => Math.max(highest, Number(match[1])), 0);
  } finally {
    controller.abort();
  }
}

export function createCommandClient({
  directory = stateDir(),
  baseUrl = atelierServerUrl({ directory }),
  followReplies = false,
} = {}) {
  let sinceSeq = 0;
  let dispatchId;
  const request = async (path, options) =>
    responseJson(await fetchDaemon(baseUrl, directory, path, options));
  const post = (path, body) => request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Atelier-Actor": "cli" },
    body: JSON.stringify(body),
  });
  return {
    baseUrl,
    async dispatch(body) {
      const result = await post("/api/dispatch", body);
      dispatchId = result.id;
      return result;
    },
    createProject(body) {
      return post("/api/projects", body);
    },
    moveTracker(project, body) {
      return post(`/api/projects/${encodeURIComponent(project)}/move-tracker`, body);
    },
    async reply(id, body) {
      dispatchId = id;
      if (followReplies) sinceSeq = await latestEventSeq(baseUrl, directory, id);
      return post(`/api/dispatch/${encodeURIComponent(id)}/reply`, body);
    },
    async plan(id, body) {
      dispatchId = id;
      return post(`/api/dispatch/${encodeURIComponent(id)}/plan`, body);
    },
    get(id) {
      return request(`/api/dispatch/${encodeURIComponent(id)}`);
    },
    getEvents() {
      return [];
    },
    onEvent(listener, onError) {
      const controller = new AbortController();
      void (async () => {
        const headers = { Accept: "text/event-stream" };
        if (sinceSeq > 0) headers["Last-Event-ID"] = String(sinceSeq);
        const response = await fetchDaemon(
          baseUrl,
          directory,
          `/api/dispatch/${encodeURIComponent(dispatchId)}/events`,
          { headers, signal: controller.signal },
        );
        if (!response.ok) await responseJson(response);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("\n");
            if (data) listener(JSON.parse(data));
          }
        }
      })().catch((error) => {
        if (error.name !== "AbortError") onError?.(error);
      });
      return () => controller.abort();
    },
  };
}
