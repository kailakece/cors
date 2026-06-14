Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // Handle preflight request CORS (Beberapa player melakukan cek OPTIONS terlebih dahulu)
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
    const targetUrl = url.searchParams.get("url");
    const customReferer = url.searchParams.get("referer");
    const customUa = url.searchParams.get("ua");

    if (!targetUrl) {
      return new Response("Error: Parameter 'url' wajib diisi.", { status: 400 });
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

      const contentType = modifiedResponse.headers.get("content-type") || "";
      
      // ==========================================
      // 1. PENANGANAN UNTUK HLS (M3U8)
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
      // 2. PENANGANAN UNTUK DASH (MPD) - FIXED!
      // ==========================================
      if (contentType.includes("dash+xml") || contentType.includes("video/vnd.mpeg.dash.mpd") || targetUrl.includes(".mpd")) {
        let mpdText = await modifiedResponse.text();
        const baseOriginalUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        const proxyParams = new URLSearchParams();
        if (customReferer) proxyParams.append('referer', customReferer);
        if (customUa) proxyParams.append('ua', customUa);

        // Hapus <BaseURL> bawaan server asli agar tidak bentrok dengan inject proxy kita
        mpdText = mpdText.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/gi, '');

        // Tulis ulang URL absolut di dalam MPD agar lewat proxy (Output disanitasi &amp;)
        const hrefRegex = /(https?:\/\/[^\s<"\']+)/g;
        mpdText = mpdText.replace(hrefRegex, (match) => {
          if (match.startsWith(url.origin)) return match;
          
          const segmentParams = new URLSearchParams(proxyParams);
          segmentParams.set('url', match);
          return `${url.origin}${url.pathname}?${segmentParams.toString()}`.replace(/&/g, '&amp;');
        });

        // Pasang <BaseURL> milik proxy di baris teratas untuk menangani semua URL relatif segmen
        const rawProxyBaseUrl = `${url.origin}${url.pathname}?url=${encodeURIComponent(baseOriginalUrl)}&${proxyParams.toString()}`;
        const safeProxyBaseUrl = rawProxyBaseUrl.replace(/&/g, '&amp;');
        
        mpdText = mpdText.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${safeProxyBaseUrl}</BaseURL>`);

        return new Response(mpdText, {
          status: 200,
          headers: {
            "Content-Type": contentType.includes("dash+xml") ? contentType : "application/dash+xml",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*"
          }
        });
      }

      // ==========================================
      // 3. SEGMEN VIDEO/AUDIO BIASA (.ts, .m4s, dll)
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
      return new Response("Terjadi kesalahan proxy: " + err.message, { status: 500 });
    }
  }

  return new Response("Proxy Server Aktif. Gunakan format: /proxy?url=LINK_STREAMING", {
    headers: { "Content-Type": "text/plain" }
  });
});
