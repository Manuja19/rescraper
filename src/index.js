export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ==========================================
    // ROUTE 1: /api/proxy (Streams IP-restricted MP4s securely)
    // ==========================================
    if (url.pathname === '/api/proxy') {
      const targetUrl = url.searchParams.get('url');
      
      // Security: Only allow proxying requests to animegg.org play endpoints
      if (!targetUrl || !targetUrl.startsWith('https://www.animegg.org/play/')) {
        return new Response(JSON.stringify({ error: 'Invalid video URL' }), { 
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const fetchHeaders = new Headers({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.animegg.org/', // Crucial for the ?for= token validation
      });
      
      // Forward Range headers for video seeking (scrubbing)
      if (request.headers.get('Range')) {
        fetchHeaders.set('Range', request.headers.get('Range'));
      }

      const response = await fetch(targetUrl, {
        method: request.method,
        headers: fetchHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      });

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Range');
      
      if (response.headers.has('Content-Range')) {
        responseHeaders.set('Content-Range', response.headers.get('Content-Range'));
      }
      responseHeaders.set('Accept-Ranges', 'bytes');
      responseHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');

      // Stream the response body directly (highly efficient in Cloudflare)
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // ==========================================
    // ROUTE 2: /api/m3u8 (Generates HLS Master Playlist)
    // ==========================================
    if (url.pathname === '/api/m3u8') {
      const urlsParam = url.searchParams.get('urls');
      if (!urlsParam) return new Response('Missing urls parameter', { status: 400, headers: corsHeaders });
      
      const urls = urlsParam.split(',');
      let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';
      urls.forEach((u, i) => {
        playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${1000000 * (i + 1)}\n${u}\n`;
      });

      return new Response(playlist, {
        headers: { ...corsHeaders, 'Content-Type': 'application/vnd.apple.mpegurl' }
      });
    }

    // ==========================================
    // ROUTE 3: /api/anime (Main Scraper)
    // ==========================================
    if (url.pathname === '/api/anime' || url.pathname === '/') {
      const { anilistId, episode, slug: manualSlug } = Object.fromEntries(url.searchParams);
      
      if (!episode) {
        return new Response(JSON.stringify({ error: 'Missing episode parameter' }), { 
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      let slug = manualSlug;
      const debugInfo = { steps: [] };

      if (!slug && anilistId) {
        try {
          debugInfo.steps.push('Fetching Anilist...');
          const anilistRes = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `query ($id: Int) { Media (id: $id, type: ANIME) { title { romaji english } } }`,
              variables: { id: parseInt(anilistId) }
            })
          });
          const data = await anilistRes.json();
          const title = data?.data?.Media?.title?.romaji || data?.data?.Media?.title?.english;
          if (title) {
            slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            debugInfo.steps.push(`Anilist mapped to slug: ${slug}`);
          } else {
            debugInfo.steps.push('Anilist returned no title');
          }
        } catch (e) {
          debugInfo.steps.push(`Anilist fetch failed: ${e.message}`);
        }
      }

      if (!slug) {
        return new Response(JSON.stringify({ error: 'Provide either a valid anilistId or a slug', _debug: debugInfo }), { 
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      const targetUrl = `https://www.animegg.org/${slug}-episode-${episode}`;
      const host = url.hostname;

      try {
        debugInfo.steps.push(`Fetching AnimeGG page: ${targetUrl}`);
        const response = await fetch(targetUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        });

        if (!response.ok) {
          return new Response(JSON.stringify({ error: `AnimeGG returned status ${response.status}`, _debug: debugInfo }), { 
            status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        const html = await response.text();
        
        if (html.includes('challenge-platform') || html.includes('Checking your browser')) {
          return new Response(JSON.stringify({ error: 'AnimeGG returned a Cloudflare challenge page', _debug: debugInfo }), { 
            status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        const subbedMatch = html.match(/<div id="subbed-Animegg"[^>]*>[\s\S]*?<iframe src="([^"]+)"/);
        const dubbedMatch = html.match(/<div id="dubbed-Animegg"[^>]*>[\s\S]*?<iframe src="([^"]+)"/);

        if (!subbedMatch && !dubbedMatch) {
          return new Response(JSON.stringify({ error: 'No subbed/dubbed iframes found in HTML', _debug: debugInfo }), { 
            status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        const result = { anime: slug, episode, anilistId: anilistId || null, subbed: null, dubbed: null, _debug: debugInfo };

        const extractSources = async (embedPath, type) => {
          if (!embedPath) return { sources: [], errors: ['No embed path found'] };
          const errors = [];
          
          const embedResponse = await fetch(`https://www.animegg.org${embedPath}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': targetUrl },
          });
          if (!embedResponse.ok) return { sources: [], errors: [`Embed fetch failed: ${embedResponse.status}`] };
          
          const embedHtml = await embedResponse.text();
          const sourcesMatch = embedHtml.match(/var videoSources = (\[[\s\S]*?\]);/);
          const sources = [];
          
          if (!sourcesMatch) return { sources: [], errors: ['videoSources variable not found in embed HTML'] };

          // Extract the DIRECT .mp4 file path and label
          const regex = /\{file:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g;
          let match;
          while ((match = regex.exec(sourcesMatch[1])) !== null) {
            const filePath = match[1];
            const label = match[2];

            try {
              // Construct the full, IP-restricted URL
              const directUrl = `https://www.animegg.org${filePath}`;
              
              // Wrap it in our Cloudflare proxy to bypass the IP restriction and CORS
              const proxiedUrl = `https://${host}/api/proxy?url=${encodeURIComponent(directUrl)}`;
              
              sources.push({ resolution: label, url: proxiedUrl });
            } catch (e) {
              errors.push(`${label}: Processing failed - ${e.message}`);
            }
          }
          return { sources, errors };
        };

        const subbedResult = subbedMatch ? await extractSources(subbedMatch[1], 'subbed') : { sources: [], errors: ['No subbed iframe'] };
        const dubbedResult = dubbedMatch ? await extractSources(dubbedMatch[1], 'dubbed') : { sources: [], errors: ['No dubbed iframe'] };

        debugInfo.subbedErrors = subbedResult.errors;
        debugInfo.dubbedErrors = dubbedResult.errors;

        const buildTypeResponse = (sources) => {
          if (sources.length === 0) return null;
          const urlsParam = sources.map(s => s.url).join(',');
          const m3u8Url = `https://${host}/api/m3u8?urls=${encodeURIComponent(urlsParam)}`;
          return { master: m3u8Url, sources };
        };

        result.subbed = buildTypeResponse(subbedResult.sources);
        result.dubbed = buildTypeResponse(dubbedResult.sources);

        if (!result.subbed && !result.dubbed) {
          return new Response(JSON.stringify({ error: 'No valid video sources found', _debug: debugInfo }), { 
            status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (error) {
        debugInfo.steps.push(`Fatal error: ${error.message}`);
        return new Response(JSON.stringify({ error: 'Internal server error', _debug: debugInfo }), { 
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};
