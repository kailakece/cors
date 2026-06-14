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

    // ==========================================
    // KILL SWITCH: ANTI-LOOP PINTU MASUK
    // ==========================================
    if (targetUrl.includes(url.hostname) || decodeURIComponent(targetUrl).includes(url.hostname)) {
      return new Response("Error: Loop terdeteksi dan diblokir.", { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
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
      // 1. PENANGANAN UNIVERSAL UNTUK HLS (M3U8)
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
      // 2. PENANGANAN DASH (MPD) - FIX METHOD UNTUK SHAKA
      // ==========================================
      if (contentType.includes("dash+xml") || contentType.includes("video/vnd.mpeg.dash.mpd") || targetUrl.includes(".mpd")) {
        let mpdText = await modifiedResponse.text();
        const baseOriginalUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        const proxyParams = new URLSearchParams();
        if (customReferer) proxyParams.append('referer', customReferer);
        if (customUa) proxyParams.append('ua', customUa);

        // BUANG total tag <BaseURL> asli (jika ada) agar Shaka dipaksa membaca modifikasi kita
        mpdText = mpdText.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/gi, '');

        // UBAH semua link relatif (seperti media="segmen.m4s") menjadi absolut + proxy
        // Regex mencari atribut media/initialization/sourceURL yang TIDAK diawali http
        const relativeAttrRegex = /(href|sourceURL|initialization|media)="((?!https?:\/\/)[^"]+)"/gi;
        
        mpdText = mpdText.replace(relativeAttrRegex, (match, attribute, relativeUrl) => {
          const fullSegmentUrl = baseOriginalUrl + relativeUrl;
          
          const segmentParams = new URLSearchParams(proxyParams);
          segmentParams.set('url', fullSegmentUrl);
          
          const finalProxyUrl = `${url.origin}${url.pathname}?${segmentParams.toString()}`.replace(/&/g, '&amp;');
          return `${attribute}="${finalProxyUrl}"`;
        });

        // UBAH jika ada link yang dari awal sudah absolut di dalam manifest
        const absoluteAttrRegex = /(href|sourceURL|initialization|media)="((https?):\/\/[^"]+)"/gi;
        mpdText = mpdText.replace(absoluteAttrRegex, (match, attribute, fullUrl) => {
          if (fullUrl.includes(url.hostname)) return match;
          
          const segmentParams = new URLSearchParams(proxyParams);
          segmentParams.set('url', fullUrl);
          
          const finalProxyUrl = `${url.origin}${url.pathname}?${segmentParams.toString()}`.replace(/&/g, '&amp;');
          return `${attribute}="${finalProxyUrl}"`;
        });

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
      // 3. SEGMEN VIDEO/AUDIO (.ts, .m4s, .mp4, dll)
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

  return new Response("Proxy Server Aktif.", { headers: { "Content-Type": "text/plain" } });
});
