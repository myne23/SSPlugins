(function() {
    function getHome(cb) {
        var keys = Object.getOwnPropertyNames(globalThis)
            .filter(function(k) {
                return /fetch|http|request|network|xhr|url/i.test(k);
            })
            .sort();

        cb({
            success: true,
            data: {
                "Runtime": [{
                    title: "Globals: " + (keys.length ? keys.join(", ") : "NINGUNO"),
                    url: "test://runtime",
                    type: "movie"
                }]
            }
        });
    }

    function search(query, page, cb) {
        cb({ success: true, data: [] });
    }

    function load(url, cb) {
        cb({
            success: true,
            data: new MultimediaItem({
                title: "Runtime test",
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
