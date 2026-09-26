(function() {
    function getHome(cb) {
        cb({
            success: true,
            data: {
                Test: [{
                    title: "fetch = " + typeof fetch,
                    url: "test://fetch",
                    type: "movie"
                }]
            }
        });
    }

    function search(query, page, cb) {
        cb({
            success: true,
            data: [{
                title: "search fetch = " + typeof fetch,
                url: "test://search",
                type: "movie"
            }]
        });
    }

    function load(url, cb) {
        cb({
            success: true,
            data: new MultimediaItem({
                title: "load fetch = " + typeof fetch,
                url: url,
                type: "movie"
            })
        });
    }

    function loadStreams(url, cb) {
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
