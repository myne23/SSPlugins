(function() {
    const BASE_URL = manifest.baseUrl;

    async function httpGet(url, headers = {}) {
        const result = await http_parallel([
            {
                url: url,
                method: "GET",
                headers: headers
            }
        ]);

        const r = Array.isArray(result) ? result[0] : result;

        if (!r) {
            throw new Error("HTTP request returned no response");
        }

        const code = r.code ?? r.statusCode ?? 0;

        if (code >= 400) {
            throw new Error("HTTP " + code + " for " + url);
        }

        return String(r.body ?? "");
    }

    function absoluteUrl(url) {
        if (!url) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url;
        }
        if (url.startsWith("//")) {
            return "https:" + url;
        }
        if (url.startsWith("/")) {
            return BASE_URL + url;
        }
        return BASE_URL + "/" + url;
    }

    function cleanHtml(text) {
        if (!text) return "";

        return text
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<\/p>/gi, " ")
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

    function extractPoster(article) {
        let match = article.match(
            /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
        );

        if (!match) {
            match = article.match(
                /style=["'][^"']*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i
            );
        }

        return match ? absoluteUrl(match[1]) : "";
    }

    function extractTitle(article) {
        let match = article.match(
            /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i
        );

        if (!match) {
            match = article.match(
                /class=["'][^"']*(?:title|name)[^"']*["'][^>]*>([\s\S]*?)<\//i
            );
        }

        if (!match) {
            match = article.match(
                /title=["']([^"']+)["']/i
            );
        }

        return match ? cleanHtml(match[1]) : "";
    }

    function extractYear(article) {
        const match = article.match(
            /(?:19|20)\d{2}/
        );

        return match ? Number(match[0]) : undefined;
    }

    function extractDescription(article) {
        let match = article.match(
            /class=["'][^"']*(?:description|overview|sinopsis|synopsis)[^"']*["'][^>]*>([\s\S]*?)<\//i
        );

        return match ? cleanHtml(match[1]) : "";
    }

    function extractLink(article) {
        const match = article.match(
            /<a[^>]+href=["']([^"']+)["']/i
        );

        return match ? absoluteUrl(match[1]) : "";
    }

    function parseArticles(html, type) {
        const results = [];
        const seen = new Set();

        const articleMatches = html.match(
            /<article[\s\S]*?<\/article>/gi
        ) || [];

        for (const article of articleMatches) {
            const url = extractLink(article);

            if (!url || seen.has(url)) {
                continue;
            }

            const title = extractTitle(article);

            if (!title) {
                continue;
            }

            seen.add(url);

            results.push(
                new MultimediaItem({
                    title: title,
                    url: url,
                    posterUrl: extractPoster(article),
                    type: type,
                    year: extractYear(article),
                    description: extractDescription(article)
                })
            );
        }

        /*
         * Fallback:
         * Some Megadede pages may not wrap every result in <article>.
         * Try common card/link structures if the article parser found nothing.
         */
        if (results.length === 0) {
            const linkMatches = html.match(
                /<a[^>]+href=["'][^"']+["'][\s\S]*?<\/a>/gi
            ) || [];

            for (const block of linkMatches) {
                const url = extractLink(block);

                if (!url || seen.has(url)) {
                    continue;
                }

                const title = cleanHtml(
                    block
                        .replace(/<img[\s\S]*?>/gi, "")
                        .replace(/<[^>]*>/g, " ")
                );

                if (!title || title.length < 2) {
                    continue;
                }

                seen.add(url);

                results.push(
                    new MultimediaItem({
                        title: title,
                        url: url,
                        posterUrl: extractPoster(block),
                        type: type,
                        year: extractYear(block),
                        description: extractDescription(block)
                    })
                );
            }
        }

        return results;
    }

    async function getHome(cb) {
        try {
            const categories = [
                {
                    name: "Películas",
                    path: "/peliculas",
                    type: "movie"
                },
                {
                    name: "Series",
                    path: "/series",
                    type: "series"
                },
                {
                    name: "Animes",
                    path: "/animes",
                    type: "anime"
                }
            ];

            /*
             * Megadede uses ?page=N for pagination.
             *
             * Fetch 5 pages of each category concurrently.
             * Page 1 is the same content we already know works.
             */
            const requests = [];

            for (const category of categories) {
                for (let page = 1; page <= 5; page++) {
                    requests.push({
                        url:
                            BASE_URL +
                            category.path +
                            "?page=" +
                            page,
                        method: "GET",
                        category: category.name,
                        type: category.type,
                        page: page
                    });
                }
            }

            const responses = await http_parallel(requests);

            const data = {};

            for (const category of categories) {
                data[category.name] = [];
            }

            const seen = {
                "Películas": new Set(),
                "Series": new Set(),
                "Animes": new Set()
            };

            const responseList = Array.isArray(responses)
                ? responses
                : [];

            for (let i = 0; i < requests.length; i++) {
                const request = requests[i];
                const response = responseList[i];

                if (!response) {
                    continue;
                }

                const code = response.code ?? response.statusCode ?? 0;

                if (code >= 400) {
                    continue;
                }

                const html = String(response.body ?? "");

                if (!html) {
                    continue;
                }

                const items = parseArticles(
                    html,
                    request.type
                );

                for (const item of items) {
                    const itemUrl = String(item.url || "");

                    if (!itemUrl) {
                        continue;
                    }

                    if (seen[request.category].has(itemUrl)) {
                        continue;
                    }

                    seen[request.category].add(itemUrl);
                    data[request.category].push(item);
                }
            }

            cb({
                success: true,
                data: data
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    async function search(query, cb) {
        try {
            const url =
                BASE_URL +
                "/search?s=" +
                encodeURIComponent(query);

            const html = await httpGet(url);

            const results = parseArticles(html, "movie");

            /*
             * Megadede search mixes movies, series and anime.
             * Determine the actual type from the URL when possible.
             */
            for (const item of results) {
                const u = String(item.url || "").toLowerCase();

                if (u.includes("/serie/")) {
                    item.type = "series";
                } else if (
                    u.includes("/anime/") ||
                    u.includes("/anim")
                ) {
                    item.type = "anime";
                } else {
                    item.type = "movie";
                }
            }

            cb({
                success: true,
                data: results
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    function extractPageTitle(html) {
        let match = html.match(
            /<h1[^>]*>([\s\S]*?)<\/h1>/i
        );

        if (!match) {
            match = html.match(
                /<title[^>]*>([\s\S]*?)<\/title>/i
            );
        }

        return match ? cleanHtml(match[1]) : "";
    }

    function extractPagePoster(html) {
        let match = html.match(
            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
        );

        if (!match) {
            match = html.match(
                /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
            );
        }

        if (!match) {
            match = html.match(
                /<img[^>]+(?:src|data-src)=["']([^"']+)["']/i
            );
        }

        return match ? absoluteUrl(match[1]) : "";
    }

    function extractPageDescription(html) {
        let match = html.match(
            /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
        );

        if (!match) {
            match = html.match(
                /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i
            );
        }

        if (match) {
            return cleanHtml(match[1]);
        }

        match = html.match(
            /class=["'][^"']*(?:description|overview|sinopsis|synopsis)[^"']*["'][^>]*>([\s\S]*?)<\//i
        );

        return match ? cleanHtml(match[1]) : "";
    }

    async function load(url, cb) {
        try {
            const html = await httpGet(url);

            const lowerUrl = url.toLowerCase();

            const isSeries =
                lowerUrl.includes("/serie/") ||
                lowerUrl.includes("/series/");

            const isAnime =
                lowerUrl.includes("/anime/") ||
                lowerUrl.includes("/animes/");

            const type = isAnime
                ? "anime"
                : isSeries
                    ? "series"
                    : "movie";

            const title =
                extractPageTitle(html) ||
                url.split("/").filter(Boolean).pop() ||
                "Megadede";

            const poster = extractPagePoster(html);
            const description = extractPageDescription(html);
            const year = extractYear(html);

            if (type === "movie") {
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title: title,
                        url: url,
                        posterUrl: poster,
                        type: "movie",
                        year: year,
                        description: description
                    })
                });

                return;
            }

            /*
             * Extract all episode links.
             *
             * Expected Megadede format:
             * /serie/vikings/temporada/1/capitulo/1
             */
            const episodeRegex =
                /href=["']([^"']*\/temporada\/(\d+)\/capitulo\/(\d+)[^"']*)["']/gi;

            const episodeMap = new Map();

            let match;

            while ((match = episodeRegex.exec(html)) !== null) {
                const episodeUrl = absoluteUrl(match[1]);
                const season = Number(match[2]);
                const episode = Number(match[3]);

                const key = season + ":" + episode;

                if (!episodeMap.has(key)) {
                    episodeMap.set(key, {
                        url: episodeUrl,
                        season: season,
                        episode: episode
                    });
                }
            }

            const episodeEntries = Array.from(episodeMap.values());

            /*
             * Fetch episode pages concurrently.
             */
            let episodeResponses = [];

            if (episodeEntries.length > 0) {
                episodeResponses = await http_parallel(
                    episodeEntries.map(ep => ({
                        url: ep.url,
                        method: "GET"
                    }))
                );
            }

            const episodes = [];

            for (let i = 0; i < episodeEntries.length; i++) {
                const ep = episodeEntries[i];
                const response = Array.isArray(episodeResponses)
                    ? episodeResponses[i]
                    : null;

                const episodeHtml = String(response?.body ?? "");

                episodes.push(
                    new Episode({
                        name:
                            "Episodio " +
                            ep.episode,
                        url: ep.url,
                        season: ep.season,
                        episode: ep.episode,
                        posterUrl:
                            extractPagePoster(episodeHtml) ||
                            poster,
                        description:
                            extractPageDescription(episodeHtml) ||
                            description
                    })
                );
            }

            episodes.sort((a, b) => {
                if (a.season !== b.season) {
                    return a.season - b.season;
                }

                return a.episode - b.episode;
            });

            cb({
                success: true,
                data: new MultimediaItem({
                    title: title,
                    url: url,
                    posterUrl: poster,
                    type: type,
                    year: year,
                    description: description,
                    episodes: episodes
                })
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    async function loadStreams(url, cb) {
        /*
         * Streams will be implemented separately.
         * For now we only verify that the content page loads.
         */
        try {
            await httpGet(url);

            cb({
                success: true,
                data: []
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
