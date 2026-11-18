/**
 * Resolve the API profile fields required by one configured AI provider.
 * `credentials` maps persisted API profile keys to provider-facing labels.
 * @private
 * @environment server
 */
export function getCredentialRequirements(providerConfig = {}, providerId = "") {
	const configured = providerConfig.credentials;
	const labels = configured && typeof configured === "object" && !Array.isArray(configured)
		? Object.fromEntries(
			Object.entries(configured)
				.filter(([key, label]) => key && typeof label === "string" && label.trim())
				.map(([key, label]) => [key, label.trim()])
		)
		: {};

	if (!Object.keys(labels).length) {
		const apiName = providerConfig.api || providerId || "AI provider";
		labels.key = `${apiName} API key`;
	}

	return { keys: Object.keys(labels), labels };
}

export function getCredentialValue(profile = {}, key = "") {
	if (!key) return undefined;
	if (key in profile) return profile[key];
	return key.split(".").reduce((current, part) => current?.[part], profile);
}

export function getMissingCredentialKeys(profile = {}, keys = []) {
	return keys.filter((key) => {
		const value = getCredentialValue(profile, key);
		return value === undefined || value === null || value === "";
	});
}
