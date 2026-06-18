Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/proxy") {
    const targetUrl = url.searchParams.get("url");
    const customReferer = url.searchParams.get("referer");
    const customUa = url.searchParams.get("ua");

    if (!targetUrl) {
      return new Response("Error: Parameter 'url' wajib diisi.", { status: 400 });
    }

    try {
      const newHeaders = new Headers(request.headers);
      newHeaders.set("Origin", new URL(targetUrl).origin);
      
      if (customReferer) newHeaders.set("Referer", customReferer);
      else newHeaders.delete("Referer");
      
      if (customUa) newHeaders.set("User-Agent", customUa);

      const modifiedResponse = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        redirect: "follow"
      });

      const contentType = modifiedResponse.headers.get("content-type") || "";
      
      if (contentType.includes("mpegurl") || contentType.includes("application/vnd.apple.mpegurl") || targetUrl.includes(".m3u8")) {
        let m3u8Text = await modifiedResponse.text();
        
        // AMBIL ID LANGSUNG DARI URL UTAMA DI AWAL
        const mainUrlObj = new URL(targetUrl);
        const channelId = mainUrlObj.searchParams.get("id");

        // Mapping domain tujuan berdasarkan ID channel
        const domainMapping = {
          "rcti": "https://rcti-linier.rctiplus.id",
          "mnctv": "https://mnctv-linier.rctiplus.id",
          "gtv": "https://gtv-linier.rctiplus.id",
          "inews": "https://inews-linier.rctiplus.id"
        };

        const targetDomain = (channelId && domainMapping[channelId]) ? domainMapping[channelId] : "https://rcti-linier.rctiplus.id";
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

          if (fullSegmentUrl.includes("https://r-plus.sedotcw3.workers.dev")) {
            fullSegmentUrl = fullSegmentUrl.replace("https://r-plus.sedotcw3.workers.dev", targetDomain);
          }

          const proxyParams = new URLSearchParams();
          proxyParams.append('url', fullSegmentUrl);
          if (customReferer) proxyParams.append('referer', customReferer);
          if (customUa) proxyParams.append('ua', customUa);

          return `${url.origin}${url.pathname}?${proxyParams.toString()}`;
        });

        const newM3u8Body = modifiedLines.join("\n");

        return new Response(newM3u8Body, {
          status: 200,
          headers: {
            "Content-Type": "application/x-mpegURL",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*"
          }
        });
      }

      // Untuk data non-m3u8 (seperti file segmen .ts)
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
