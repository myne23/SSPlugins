(function () {

    const BASE_URL = manifest.baseUrl;

    function absoluteUrl(url) {
        if (!url) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        if (url.startsWith("/")) return BASE_URL + url;
        return BASE_URL + "/" + url;
    }

    function cleanHtml(text) {
        if (!text) return "";
        return text
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/\s+/g, " ")
            .trim();
    }

    function extractPoster(html) {
        let match = html.match(
            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
        );

        if (!match) {
            match = html.match(
                /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
            );
        }

        if (match && match[1]) {
            return absoluteUrl(match[1]);
        }

        match = html.match(
            /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
        );

        return match ? absoluteUrl(match[1]) : "";
    }

    function extractYear(html) {
        const match = html.match(/\b(19\d{2}|20\d{2})\b/);
        return match ? Number(match[1]) : undefined;
    }

    function extractDescription(html) {
        let match = html.match(
            /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
        );

        if (!match) {
            match = html.match(
                /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i
            );
        }

        if (!match) {
            match = html.match(
                /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i
            );
        }

        if (!match) {
            match = html.match(
                /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i
            );
        }

        if (match) {
            return cleanHtml(match[1]);
        }

        const fallback = html.match(
            /<h[1-6][^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i
        );

        return fallback ? cleanHtml(fallback[1]) : "";
    }

    function extractTitle(html) {
        const match = html.match(
            /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i
        );

        return match ? cleanHtml(match[1]) : "";
    }

    function parseArticles(html) {
        const results = [];

        const articleRegex = /<article\b[^>]*class=["'][^"']*mv[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi;

        let articleMatch;

        while ((articleMatch = articleRegex.exec(html)) !== null) {
            const article = articleMatch[0];

            const hrefMatch = article.match(
                /<a[^>]+href=["']([^"']+)["']/i
            );

            if (!hrefMatch) continue;

            const url = absoluteUrl(hrefMatch[1]);

            let type;

            if (url.includes("/anime/")) {
                type = "anime";
            } else if (url.includes("/serie/")) {
                type = "series";
            } else if (url.includes("/pelicula/")) {
                type = "movie";
            } else {
                continue;
            }

            const imageMatch = article.match(
                /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
            );

            const titleMatch = article.match(
                /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i
            );

            let title = titleMatch
                ? cleanHtml(titleMatch[1])
                : "";

            if (!title && imageMatch) {
                const titleAttr = article.match(
                    /<img[^>]+(?:title|alt)=["']([^"']+)["']/i
                );

                if (titleAttr) {
                    title = cleanHtml(titleAttr[1]);
                }
            }

            if (!title) continue;

            results.push(
                new MultimediaItem({
                    title: title,
                    url: url,
                    posterUrl: imageMatch
                        ? absoluteUrl(imageMatch[1])
                        : "",
                    type: type
                })
            );
        }

        return results;
    }

    async function getHome(cb) {
        try {
            const sections = [
                ["Películas", BASE_URL + "/peliculas"],
                ["Series", BASE_URL + "/series"],
                ["Animes", BASE_URL + "/animes"]
            ];

            const data = {};

            for (const [name, url] of sections) {
                const response = await fetch(url, {
                    headers: {
                        "Referer": BASE_URL
                    }
                });

                const html = await response.text();

                data[name] = parseArticles(html);
            }

            cb({
                success: true,
                data: data
            });

        } catch (e) {
            console.error("Megadede getHome:", e);

            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    async function search(query, page, cb) {
        try {
            const encoded = encodeURIComponent(query);

            let url = BASE_URL + "/search?s=" + encoded;

            if (page && Number(page) > 1) {
                url += "&page=" + Number(page);
            }

            const response = await fetch(url, {
                headers: {
                    "Referer": BASE_URL
                }
            });

            const html = await response.text();

            let results = parseArticles(html);

            results = results.map(item => {
                let title = item.title
                    .replace(/^Ver\s+/i, "")
                    .replace(/\s*-\s*Ver online.*$/i, "")
                    .replace(/\s*\((?:19|20)\d{2}\)\s*online.*$/i, "")
                    .trim();

                return new MultimediaItem({
                    title: title,
                    url: item.url,
                    posterUrl: item.posterUrl,
                    type: item.type
                });
            });

            cb({
                success: true,
                data: results
            });

        } catch (e) {
            console.error("Megadede search:", e);

            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    async function load(url, cb) {
        try {
            const pageUrl = absoluteUrl(url);

            const response = await fetch(pageUrl, {
                headers: {
                    "Referer": BASE_URL
                }
            });

            const html = await response.text();

            const title = extractTitle(html) || pageUrl;
            const posterUrl = extractPoster(html);
            const year = extractYear(html);
            const description = extractDescription(html);

            const isAnime = pageUrl.includes("/anime/");
            const isSeries =
                pageUrl.includes("/serie/") ||
                isAnime;

            if (!isSeries) {
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: title,
                        url: pageUrl,
                        posterUrl: posterUrl,
                        type: "movie",
                        year: year,
                        description: description
                    })
                });

                return;
            }

            const episodes = [];

            const episodeRegex =
                /href=["']([^"']*\/temporada\/(\d+)\/capitulo\/(\d+)[^"']*)["']/gi;

            const seen = new Set();

            let match;

            while ((match = episodeRegex.exec(html)) !== null) {
                const episodeUrl = absoluteUrl(match[1]);
                const season = Number(match[2]);
                const episode = Number(match[3]);

                if (seen.has(episodeUrl)) continue;
                seen.add(episodeUrl);

                episodes.push({
                    url: episodeUrl,
                    season: season,
                    episode: episode
                });
            }

            episodes.sort((a, b) => {
                if (a.season !== b.season) {
                    return a.season - b.season;
                }

                return a.episode - b.episode;
            });

            const episodeResults = await Promise.all(
                episodes.map(async (ep) => {
                    let episodePoster = posterUrl;
                    let episodeDescription = "";

                    try {
                        const episodeResponse = await fetch(ep.url, {
                            headers: {
                                "Referer": pageUrl
                            }
                        });

                        const episodeHtml = await episodeResponse.text();

                        const foundPoster = extractPoster(episodeHtml);

                        if (foundPoster) {
                            episodePoster = foundPoster;
                        }

                        episodeDescription =
                            extractDescription(episodeHtml);

                    } catch (e) {
                        console.error(
                            "Megadede episode:",
                            ep.url,
                            e
                        );
                    }

                    return new Episode({
                        name: "Episodio " + ep.episode,
                        url: ep.url,
                        season: ep.season,
                        episode: ep.episode,
                        posterUrl: episodePoster,
                        description: episodeDescription
                    });
                })
            );

            const type = isAnime ? "anime" : "series";

            cb({
                success: true,
                data: new MultimediaItem({
                    title: title,
                    url: pageUrl,
                    posterUrl: posterUrl,
                    type: type,
                    year: year,
                    description: description,
                    episodes: episodeResults
                })
            });

        } catch (e) {
            console.error("Megadede load:", e);

            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    async function loadStreams(url, cb) {
        cb({
            success: true,
            data: []
        });
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

})();
