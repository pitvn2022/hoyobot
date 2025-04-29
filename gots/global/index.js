const definition = {
	name: "Global",
	optionsType: "function",
	options: (() => ({
		responseType: "json",
		http2: true,
		retry: {
			limit: 0
		},
		timeout: {
			request: 30000
		},
		mutableDefaults: true,
		throwHttpErrors: false,
		headers: {
			"User-Agent": app.Config.get("userAgent")
		},
		hooks: {
			beforeError: [
				async (err) => {
					if (!err || err.code !== "ETIMEDOUT") {
						return err;
					}

					app.Logger.log("GotRequest", {
						error: err,
						context: {
							code: err.code,
							responseType: err.options?.responseType ?? null,
							timeout: err.options?.timeout ?? null,
							url: err.options?.url?.toString?.() ?? null
						}
					});

					return err;
				}
			]
		}
	})),
	parent: null
};

module.exports = definition;
