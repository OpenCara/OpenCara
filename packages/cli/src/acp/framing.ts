// Newline-delimited JSON framing for ACP.
//
// Verified against zed-industries/agent-client-protocol@0.4.5
// (typescript/stream.ts → `ndJsonStream`). Each JSON-RPC message is emitted
// as a single line of compact JSON terminated by \n. This is NOT the
// LSP-style Content-Length framing — ACP intentionally chose ndjson.
//
// We keep this module pure (no streams, no events) so it's trivially testable
// with synthetic strings. The AcpClient wires it onto a child process's stdio.

import type { JsonRpcMessage } from "./jsonrpc.js";

/**
 * Encode a single JSON-RPC message for the wire: compact JSON + trailing \n.
 *
 * Throws if `msg` is not JSON-serializable (BigInt, circular ref, etc.).
 */
export function encodeFrame(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Stateful line-splitter. Feed arbitrary chunks; receive a list of complete
 * JSON-RPC messages plus a list of malformed lines (caller decides whether to
 * log/ignore). Empty lines (e.g. an agent flushing whitespace) are dropped
 * silently — same behavior as the upstream `ndJsonStream`.
 */
export class FrameDecoder {
  private buffer = "";

  /** Feed a chunk. Returns parsed messages and any malformed lines. */
  feed(chunk: string): { messages: JsonRpcMessage[]; malformed: string[] } {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];
    const malformed: string[] = [];

    // Split on \n; the final element is whatever followed the last \n and may
    // be a partial line we have to keep buffering.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
          // Cast through unknown: we don't validate at runtime here; the
          // consumer (AcpConnection.dispatch) makes property-presence
          // decisions and will surface unexpected shapes at the touch point.
          messages.push(parsed as unknown as JsonRpcMessage);
        } else {
          malformed.push(trimmed);
        }
      } catch {
        malformed.push(trimmed);
      }
    }

    return { messages, malformed };
  }

  /** Whatever's still buffered (a partial line awaiting more data). */
  remainder(): string {
    return this.buffer;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
