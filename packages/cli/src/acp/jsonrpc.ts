// JSON-RPC 2.0 message shapes used on the wire by ACP.
//
// Reference: https://www.jsonrpc.org/specification
//
// Kept deliberately minimal — we don't validate at runtime. ACP's authoritative
// schema lives in zed-industries/agent-client-protocol; if a malformed frame
// arrives, the consumer code will see an unexpected shape and error at the
// touch point. We accept that rather than carrying a Zod runtime dep here.

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return "id" in m && !("method" in m);
}

export function isError(m: JsonRpcResponse): m is JsonRpcError {
  return "error" in m;
}

// Standard error codes from the JSON-RPC 2.0 spec.
export const JSON_RPC_ERROR_PARSE = -32700;
export const JSON_RPC_ERROR_INVALID_REQUEST = -32600;
export const JSON_RPC_ERROR_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_ERROR_INVALID_PARAMS = -32602;
export const JSON_RPC_ERROR_INTERNAL = -32603;
