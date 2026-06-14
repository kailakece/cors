Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // Handle preflight request CORS
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

    // Kupas tuntas jika ada sisa loop lama dari cache browser/player
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
      const newHeaders = new Headers(request.headers);
      try {
        newHeaders.set("Origin", new URL(targetUrl).origin);
      } catch (_e) {
        return new Response("Error: Format 'url' tidak valid.", { status: 400 });
      }
      
      if (customReferer) newHeaders.set("Referer", customReferer);
      else newHeaders.delete("Referer");
      
      if (customUa) newHeaders.set("User-Agent", customUa);

      const modifiedResponse = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        redirect: "follow"
      });

      if (modifiedResponse.status === 404) {
        return new Response("404 Not Found di server target.", { 
          status: 404,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }

      const contentType = modifiedResponse.headers.get("content-type") || "";

      // ==========================================
      // 1. PENANGANAN WAJIB UNTUK HLS (M3U8)
      // ==========================================
      // Kita tetap pertahankan ini karena Shaka Player butuh bantuan proxy 
      // untuk mengurai baris path relatif pada struktur file .m3u8
      if (contentType.includes("mpegurl") || contentType.includes("application/vnd.apple.mpegurl") || targetUrl.includes(".m3u8")) {
        let m3u8Text = await modifiedResponse.text();
        const baseOriginalUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
        const lines = m3u8Text.split("\n");
        
        const modifiedLines = lines.map(line => {
          if (line.trim() === "" || line.startsWith("#")) {
            return line;
          }
          
          let fullSegmentUrl = line;
          if (!line.startsWith("http")) {
            fullSegmentUrl = baseOriginalUrl + line;
          }

          const proxyParams = new URLSearchParams();
          proxyParams.append('url', fullSegmentUrl);
          if (customReferer) proxyParams.append('referer', customReferer);
          if (customUa) proxyParams.append('ua', customUa);

          return `${url.origin}${url.pathname}?${proxyParams.toString()}`;
        });

        return new Response(modifiedLines.join("\n"), {
          status: 200,
          headers: {
            "Content-Type": "application/x-mpegURL",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*"
          }
        });
      }

      // ==========================================
      // 2. PENANGANAN DASH (MPD) & SEGMEN VIDEO BIASA
      // ==========================================
      // Untuk DASH (.mpd), kita kembalikan data mentah aslinya secara utuh 100%. 
      // Mengapa? Karena urusan pembungkusan segmen DASH sudah ditangani dengan sangat cerdas 
      // oleh skrip "Request Filter" baru yang kita pasang di sisi player kamu tadi.
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
