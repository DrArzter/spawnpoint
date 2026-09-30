type RequestBodyEvent = Readonly<{
  body?: string;
  isBase64Encoded?: boolean;
}>;

export function requestBody(event: RequestBodyEvent): string {
  const body = event.body ?? "";
  return event.isBase64Encoded === true ? Buffer.from(body, "base64").toString("utf8") : body;
}
