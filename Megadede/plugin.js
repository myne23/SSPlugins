(function() {
    async function getHome(cb) {
        try {
            const result = await http_parallel([
                {
                    url: "https://megadede.mobi/peliculas",
                    method: "GET"
                }
            ]);

            const r = Array.isArray(result) ? result[0] : result;
            const body = r && r.body != null ? String(r.body) : "";

            cb({
                success: true,
                data: {
                    "HTTP TEST": [{
                        title:
                            "code=" + (r && r.code) +
                            " | statusCode=" + (r && r.statusCode) +
                            " | bodyType=" + typeof (r && r.body) +
                            " | bodyLength=" + body.length +
                            " | body=" + body.slice(0, 300),
                        url: "test://http",
                        type: "movie"
                    }]
                }
            });
        } catch (e) {
            cb({
                success: false,
                errorCode: "NETWORK_ERROR",
                message: String(e)
            });
        }
    }

    async function search(query, page, cb) {
        cb({ success: true, data: [] });
    }

    function load(url, cb) {
        cb({
            success: true,
            data: new MultimediaItem({
                title: "HTTP test",
                url: url,
                type: "movie"
            })
        });
    }

    function loadStreams(url, cb) {
        cb({ success: true, data: [] });
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
