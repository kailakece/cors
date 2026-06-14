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
    let customReferer = url.searchParams.get("referer");
    let customUa = url.searchParams.get("ua");
    const headerData = url.searchParams.get("hdata"); // Mengambil data terenkripsi Base64

    if (!targetUrl) {
      return new Response("Error: Parameter 'url' wajib diisi.", { status: 400 });
    }

    // ==========================================
    // 1. AUTO-UNWRAP LOOP (PERTAHANAN LEVEL UTAMA)
    // ==========================================
    let loopCounter = 0;
    while ((targetUrl.includes(url.hostname) || decodeURIComponent(targetUrl).includes(url.hostname)) && loopCounter < 5) {
      try {
        const checkUrlText = targetUrl.includes("http") ? targetUrl : decodeURIComponent(targetUrl);
        const nestedUrl = new URL(checkUrlText.startsWith("http") ? checkUrlText : `http://${checkUrlText}`);
        const extractedUrl = nestedUrl.searchParams.get("url");
        if (extractedUrl && extractedUrl !== targetUrl) {
          targetUrl = extractedUrl;
        } else {
          const cleanRegex = new RegExp(`https?:\/\/${url.hostname}\/proxy\\?url=`, "gi");
          targetUrl = decodeURIComponent(targetUrl).replace(cleanRegex, "");
          break;
        }
      } catch (_e) {
        break;
      }
      loopCounter++;
    }
    targetUrl = decodeURIComponent(targetUrl);

    // ==========================================
    // 2. DECODE DATA REFERER & UA DARI BASE64
    // ==========================================
    if (headerData) {
      try {
        const decodedText = atob(headerData);
        const parsedHeaders = JSON.parse(decodedText);
        if (parsedHeaders.referer) customReferer = parsedHeaders.referer;
        if (parsedHeaders.ua) customUa = parsedHeaders.ua;
      } catch (_e) {
        // Abaikan jika gagal decode
      }
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
      
      // Bungkus data referer dan UA menjadi string Base64 yang aman dari pencemaran XML Shaka
      const tokenPayload = {};
      if (customReferer) tokenPayload.referer = customReferer;
      if (customUa) tokenPayload.ua = customUa;
      const safeToken = btoa(JSON.stringify(tokenPayload));

      // ==========================================
      // 3. PENANGANAN UNIVERSAL UNTUK HLS (M3U8)
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

          return `${url.origin}${url.pathname}?url=${encodeURIComponent(fullSegmentUrl)}&hdata=${safeToken}`;
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
      // 4. PENANGANAN DASH (MPD) - ANTI ERROR 3008 & 508
      // ==========================================
      if (contentType.includes("dash+xml") || contentType.includes("video/vnd.mpeg.dash.mpd") || targetUrl.includes(".mpd")) {
        let mpdText = await modifiedResponse.text();
        const baseOriginalUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        // Bersihkan total tag BaseURL bawaan agar Shaka fokus pada manipulasi path kita
        mpdText = mpdText.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/gi, '');

        // Ganti path RELATIF menjadi absolut + enkripsi hdata
        const relativeAttrRegex = /(href|sourceURL|initialization|media)="((?!https?:\/\/)[^"]+)"/gi;
        mpdText = mpdText.replace(relativeAttrRegex, (match, attribute, relativeUrl) => {
          const fullSegmentUrl = baseOriginalUrl + relativeUrl;
          const finalProxyUrl = `${url.origin}${url.pathname}?url=${encodeURIComponent(fullSegmentUrl)}&amp;hdata=${safeToken}`;
          return `${attribute}="${finalProxyUrl}"`;
        });

        // Ganti path ABSOLUT bawaan menjadi proxy + enkripsi hdata
        const absoluteAttrRegex = /(href|sourceURL|initialization|media)="((https?):\/\/[^"]+)"/gi;
        mpdText = mpdText.replace(absoluteAttrRegex, (match, attribute, fullUrl) => {
          if (fullUrl.includes(url.hostname) || decodeURIComponent(fullUrl).includes(url.hostname)) return match;
          const finalProxyUrl = `${url.origin}${url.pathname}?url=${encodeURIComponent(fullUrl)}&amp;hdata=${safeToken}`;
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
      // 5. SEGMEN VIDEO/AUDIO (.ts, .m4s, .mp4, dll)
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
