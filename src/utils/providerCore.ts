export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function getMedia(id: number | string) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        title {
          romaji
          english
          native
        }
        synonyms
      }
    }
  `;
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { id: Number(id) }
    })
  });
  
  if (!res.ok) throw new Error(`AniList API error: ${res.status}`);
  const data = await res.json();
  return data.data.Media;
}

export function buildTitles(media: any): string[] {
  const titles = new Set<string>();
  if (media.title?.english) titles.add(media.title.english);
  if (media.title?.romaji) titles.add(media.title.romaji);
  if (media.title?.native) titles.add(media.title.native);
  if (Array.isArray(media.synonyms)) {
    media.synonyms.forEach((s: string) => titles.add(s));
  }
  return Array.from(titles).filter(Boolean);
}
