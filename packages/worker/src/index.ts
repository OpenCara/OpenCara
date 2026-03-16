export default {
  async fetch(request: Request): Promise<Response> {
    void request;
    return new Response('OK', { status: 200 });
  },
} satisfies ExportedHandler;
