export type WebApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type WebApiQueryValue = string | number | boolean | null | undefined;
export type WebApiQuery = Record<string, WebApiQueryValue | WebApiQueryValue[]>;
export type WebApiPath = string;

export interface WebApiClientOptions<P extends WebApiPath = WebApiPath> {
  method?: WebApiMethod;
  query?: WebApiQuery;
  headers?: Record<string, string>;
  body?: unknown;
}

export type WebApiClientResponse<P extends WebApiPath> = any;
