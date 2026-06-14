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
      // 1. PENANGANAN UNTUK HLS (M3U8) - AMAN
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
      // 2. PENANGANAN UNTUK DASH (MPD) - ANTI-LOOP FIXED!
      // ==========================================
      if (contentType.includes("dash+xml") || contentType.includes("video/vnd.mpeg.dash.mpd") || targetUrl.includes(".mpd")) {
        let mpdText = await modifiedResponse.text();
        
        // Dapatkan base URL dari manifest MPD asli
        const baseOriginalUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        // Bersihkan <BaseURL> bawaan asli (jika ada) agar tidak konflik relative path-nya
        mpdText = mpdText.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/gi, '');

        // Susun parameter untuk diteruskan ke segmen video (.m4s / .mp4)
        const proxyParams = new URLSearchParams();
        proxyParams.append('url', baseOriginalUrl); // Mengarahkan base segmen ke folder aslinya
        if (customReferer) proxyParams.append('referer', customReferer);
        if (customUa) proxyParams.append('ua', customUa);

        // URL Proxy Base yang aman dengan meng-escape karakter '&' menjadi '&amp;' khusus untuk format XML (MPD)
        const safeProxyBaseUrl = `${url.origin}${url.pathname}?${proxyParams.toString()}`.replace(/&/g, '&amp;');
        
        // Suntikkan <BaseURL> proxy kita tepat di bawah tag <MPD ...>
        // Dengan ini, semua segmen audio/video relatif otomatis akan memanggil proxy kamu + referer + ua
        mpdText = mpdText.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${safeProxyBaseUrl}</BaseURL>`);

        return new Response(mpdText, {
          status: 200,
          headers: {
            "Content-Type": "application/dash+xml",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*"
          }
        });
      }

      // ==========================================
      // 3. SEGMEN VIDEO/AUDIO BIASA (.ts, .m4s, .mp4, dll)
      // ==========================================
      const responseHeaders = new Headers(modifiedResponse.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "*");

      // Teruskan headers esensial yang mungkin dibutuhkan player (seperti Content-Range untuk seeking)
      return new Response(modifiedResponse.body, {
        status: modifiedResponse.status,
        statusText: modifiedResponse.statusText,
        headers: responseHeaders
      });

    } catch (err) {
      return new Response("Terjadi kesalahan proxy: " + err.message, { status: 500 });
    }
  }

  return new Response("Proxy Server Aktif. Gunakan format: /proxy?url=LINK_STREAMING&referer=REFERER&ua=USER_AGENT", {
    headers: { "Content-Type": "text/plain" }
  });
});
