Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. Handle preflight request CORS (Wajib agar tidak diblokir browser)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  if (path === "/proxy") {
    let targetUrl = url.searchParams.get("url");
    const customReferer = url.searchParams.get("referer");
    const customUa = url.searchParams.get("ua");

    if (!targetUrl) {
      return new Response("Error: Parameter 'url' wajib diisi.", { status: 400 });
    }

    // Kupas tuntas loop url akibat cache browser/player jika ada
    while (targetUrl.includes("proxy?url=")) {
      try {
        const parts = targetUrl.split("url=");
        targetUrl = decodeURIComponent(parts[parts.length - 1]).split("&")[0];
      } catch (_e) {
        break;
      }
    }
    targetUrl = decodeURIComponent(targetUrl);

    try {
      // 2. Duplikat header dari client dan bersihkan untuk server target
      const newHeaders = new Headers(request.headers);
      try {
        newHeaders.set("Origin", new URL(targetUrl).origin);
      } catch (_e) {
        return new Response("Error: Format 'url' tidak valid.", { status: 400 });
      }
      
      // Pasang Referer jika dikirim dari playlist
      if (customReferer) newHeaders.set("Referer", customReferer);
      else newHeaders.delete("Referer");
      
      // Pasang User-Agent jika dikirim dari playlist
      if (customUa) newHeaders.set("User-Agent", customUa);

      // 3. Tembak ke server target (RCTI / lainnya) membawa header palsu kita
      const modifiedResponse = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        redirect: "follow"
      });

      // 4. Kirim balik DATA MURNI 100% tanpa diubah sedikitpun ke player
      const responseHeaders = new Headers(modifiedResponse.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "*");

      return new Response(modifiedResponse.body, {
        status: modifiedResponse.status,
        statusText: modifiedResponse.statusText,
        headers: responseHeaders
      });

    } catch (err) {
      return new Response("Terjadi kesalahan proxy: " + err.message, { 
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
  }

  return new Response("Proxy Server Aktif.", { headers: { "Content-Type": "text/plain" } });
});
