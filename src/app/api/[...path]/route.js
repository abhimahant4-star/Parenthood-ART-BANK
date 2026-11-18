export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request) {
  const { handleApiRequest } = await import("@/server/http/app");
  return handleApiRequest(request);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as OPTIONS };
