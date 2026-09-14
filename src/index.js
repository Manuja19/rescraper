export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers for your AnimeVault frontend
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // ROUTE 1: /api/m3u8 (Generates the HLS Playlist)
    // ==========================================
    if (url.pathname === '/api/m3u8') {
      const urlsParam = url.searchParams.get('urls');
      if (!urlsParam) {
        return new Response('Missing urls parameter', { status: 400, headers: corsHeaders });
      }
      
      const urls = urlsParam.split(',');
      let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n';
      
      // Assign increasing bandwidth to simulate different qualities
      urls.forEach((u, i) => {
        const bandwidth = 1000000 * (i + 1);
        playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}\n${u}\n`;
      });

      return new Response(playlist, {
        headers: { ...corsHeaders, 'Content-Type': 'application/vnd.apple.mpegurl' }
      });
    }

    // ==========================================
    // ROUTE 2: /api/anime (Main Scraper Endpoint)
    // ==========================================
    if (url.pathname === '/api/anime' || url.pathname === '/') {
      const { anilistId, episode, slug: manualSlug } = Object.fromEntries(url.searchParams);
      
      if (!episode) {
        return new Response(JSON.stringify({ error: 'Missing episode parameter' }), { 
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      let slug = manualSlug;

      // 1. Map Anilist ID to Slug (Only if slug isn't manually provided)
      if (!slug && anilistId) {
        try {
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
            // Convert "To Be Hero X" -> "to-be-hero-x"
            slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          }
        } catch (e) {
          console.error('Anilist fetch failed', e);
        }
      }

      // If we still don't have a slug, fail gracefully
      if (!slug) {
        return new Response(JSON.stringify({ error: 'Provide either a valid anilistId or a slug' }), { 
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      const targetUrl = `https://www.animegg.org/${slug}-episode-${episode}`;
      const host = url.hostname; // Dynamically gets your worker's URL

      try {
        const response = await fetch(targetUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        });

        if (!response.ok) {
          return new Response(JSON.stringify({ error: 'Failed to fetch episode page' }), { 
            status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        const html = await response.text();
        const subbedMatch = html.match(/<div id="subbed-Animegg"[^>]*>[\s\S]*?<iframe src="([^"]+)"/);
        const dubbedMatch = html.match(/<div id="dubbed-Animegg"[^>]*>[\s\S]*?<iframe src="([^"]+)"/);

        const result = { anime: slug, episode, anilistId: anilistId || null, subbed: null, dubbed: null };

        // Helper to extract and decode video sources
        const extractSources = async (embedPath) => {
          if (!embedPath) return [];
          const embedResponse = await fetch(`https://www.animegg.org${embedPath}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': targetUrl },
          });
          if (!embedResponse.ok) return [];
          
          const embedHtml = await embedResponse.text();
          const sourcesMatch = embedHtml.match(/var videoSources = (\[[\s\S]*?\]);/);
          const sources = [];
          
          if (sourcesMatch) {
            const regex = /\{file:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*bk:\s*"([^"]*)"/g;
            let match;
            while ((match = regex.exec(sourcesMatch[1])) !== null) {
              const base64Bk = match[3];
              const label = match[2];
              if (!base64Bk) continue;

              try {
                // Decode base64 -> URL decode -> Final URL
                const decodedBk = atob(base64Bk);
                let finalUrl = decodeURIComponent(decodedBk);

                if (finalUrl.includes('.mp4') || finalUrl.includes('.m3u8')) {
                  sources.push({ resolution: label, url: finalUrl.replace(/^http:\/\//i, 'https://') });
                } else if (finalUrl.includes('http')) {
                  // Scrape third-party embeds (like mp4upload) for the real MP4
                  const embedPageResponse = await fetch(finalUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.animegg.org/' }
                  });
                  if (embedPageResponse.ok) {
                    const embedPageHtml = await embedPageResponse.text();
                    if (embedPageHtml.includes('File was deleted')) continue;
                    const mp4Match = embedPageHtml.match(/(?:file|src|url):\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
                    if (mp4Match && mp4Match[1]) sources.push({ resolution: label, url: mp4Match[1] });
                  }
                }
              } catch (e) {}
            }
          }
          return sources;
        };

        const subbedSources = subbedMatch ? await extractSources(subbedMatch[1]) : [];
        const dubbedSources = dubbedMatch ? await extractSources(dubbedMatch[1]) : [];

        // Generate the single m3u8 Master Playlist URL
        const buildTypeResponse = (sources) => {
          if (sources.length === 0) return null;
          const urlsParam = sources.map(s => s.url).join(',');
          const m3u8Url = `https://${host}/api/m3u8?urls=${encodeURIComponent(urlsParam)}`;
          return { master: m3u8Url, sources };
        };

        result.subbed = buildTypeResponse(subbedSources);
        result.dubbed = buildTypeResponse(dubbedSources);

        if (!result.subbed && !result.dubbed) {
          return new Response(JSON.stringify({ error: 'No valid video sources found' }), { 
            status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          });
        }

        return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (error) {
        console.error('Scraping error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), { 
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};
