// Variabel global untuk mengingat folder manifest terakhir yang di-request secara dinamis
let LAST_STREAM_BASE_URL = "https://storage.googleapis.com/shaka-demo-assets/angel-one/";

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

    // ==========================================
    // JARING PENGAMAN UNIVERSAL 1: JIKA SEGMEN MASUK TANPA ?url= DI JALUR /proxy
    // ==========================================
    if (!targetUrl) {
      const fallbackFile = path.replace("/", "");
      if (fallbackFile && fallbackFile !== "proxy") {
        targetUrl = `${LAST_STREAM_BASE_URL}${fallbackFile}`;
      } else {
        return new Response("Error: Parameter 'url' tidak ditemukan.", { status: 400 });
      }
    }

    // Kupas tuntas jika ada sisa loop bersarai akibat cache player
    while (targetUrl.includes("proxy?url=")) {
      try {
        const parts = targetUrl.split("url=");
        targetUrl = decodeURIComponent(parts[parts.length - 1]).split("&")[0];
      } catch (_e) {
        break;
      }
    }
    targetUrl = decodeURIComponent(targetUrl);

    // OTOMATIS REKAM BASE URL UTAMA (Mendukung Multi-Link Secara Dinamis)
    if (targetUrl.includes(".mpd") || targetUrl.includes(".m3u8")) {
      LAST_STREAM_BASE_URL = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
    }

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
      // PENANGANAN UNTUK HLS (M3U8) - UNTUK VIDEO.JS
      // ==========================================
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
      // PENANGANAN DASH (.MPD) VIA SHAKA & SEGMEN VIDEO MURNI (.webm, .mp4, .m4s)
      // ==========================================
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

  // ==========================================
  // JARING PENGAMAN UNIVERSAL 2: JIKA REKUEST SEGMEN MASUK KE ROOT UTAMA (Bukan /proxy)
  // ==========================================
  const cleanPathFile = path.replace("/", "");
  if (cleanPathFile && cleanPathFile !== "proxy") {
    const fallbackTarget = `${LAST_STREAM_BASE_URL}${cleanPathFile}`;
    try {
      const fallbackResponse = await fetch(fallbackTarget, { redirect: "follow" });
      const fallbackHeaders = new Headers(fallbackResponse.headers);
      fallbackHeaders.set("Access-Control-Allow-Origin", "*");
      
      return new Response(fallbackResponse.body, {
        status: fallbackResponse.status,
        headers: fallbackHeaders
      });
    } catch (_err) {
      return new Response("File segmen tidak valid.", { status: 404 });
    }
  }

  return new Response("Proxy Server Aktif.", { headers: { "Content-Type": "text/plain" } });
});
