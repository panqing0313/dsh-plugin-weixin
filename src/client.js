window.__ModuleLoader__.load({
	id: "dsh-plugin-weixin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		//#region schema thunks (minimal strict codecs; wire is plain JSON)
		let _str$value;
		const _str = () => (_str$value ??= intersection(string(), unknown()));
		let _strMap$value;
		const _strMap = () => (_strMap$value ??= intersection(record(string()), unknown()));
		let _num$value;
		const _num = () => (_num$value ??= intersection(number(), unknown()));
		let _statusResult$value;
		const _statusResult = () => (_statusResult$value ??= intersection(unknown(), unknown()));

		function intersection(left, right) {
			return { type: "intersection", left, right };
		}
		function string() {
			return { type: "string" };
		}
		function number() {
			return { type: "number" };
		}
		function record(key) {
			return { type: "record", key };
		}
		function unknown() {
			return { type: "unknown" };
		}
		//#endregion

		const PKG = "dsh-plugin-weixin";
		// Kept in step with package.json by bin/release.mjs bumpVersion() — the card
		// cannot import package.json, so the release script rewrites this line.
		const PLUGIN_VERSION = "0.9.17";
		const NS = "dshPluginWeixin";

		const TYPERT_REMOTE = {
			package: PKG,
			descriptors: [
				// weixin namespace (WeixinLoginController)
				{
					id: `${PKG}#weixin/startLogin`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "startLogin",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/startLogin:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/poll`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "poll",
					invocation: { kind: "direct" },
					parameters: [{ name: "sessionKey", wire: "sessionKey", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/poll:param`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/poll:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/submitVerifyCode`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "submitVerifyCode",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionKey", wire: "sessionKey", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/submitVerifyCode:p0`, create: _str } },
						{ name: "code", wire: "code", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/submitVerifyCode:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/submitVerifyCode:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/cancel`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "cancel",
					invocation: { kind: "direct" },
					parameters: [{ name: "sessionKey", wire: "sessionKey", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/cancel:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/cancel:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/status`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "status",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/status:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/logout`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "logout",
					invocation: { kind: "direct" },
					parameters: [{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/logout:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/logout:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/sessions`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "sessions",
					invocation: { kind: "direct" },
					parameters: [],
					// `unknown ∩ unknown`, like every other result here: the
					// protocol requires a strict codec, and this one accepts any
					// shape, so adding a field to a session line cannot make the
					// card fail to mount.
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/sessions:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/useSession`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "useSession",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "conversationId", wire: "conversationId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/useSession:p0`, create: _str } },
						{ name: "index", wire: "index", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/useSession:p1`, create: _num } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/useSession:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/reminders`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "reminders",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/reminders:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/donateQr`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "donateQr",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/donateQr:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/remindCancel`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "remindCancel",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "id", wire: "id", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/remindCancel:p0`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/remindCancel:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/journal`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "journal",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/journal:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/journal:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/journalExport`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "journalExport",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/journalExport:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/journalExport:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/outbox`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "outbox",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/outbox:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/outboxRetry`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "outboxRetry",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/outboxRetry:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/outboxDrop`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "outboxDrop",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/outboxDrop:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/outboxDrop:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/metrics`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "metrics",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/metrics:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/storage`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "storage",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/storage:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/stats`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "stats",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/stats:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/stats:result`, create: _statusResult },
				},

				{
					id: `${PKG}#weixin/contacts`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "contacts",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/contacts:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/contacts:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/contactSave`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "contactSave",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/contactSave:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/contactSave:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/packExport`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "packExport",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/packExport:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/packExport:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/packImport`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "packImport",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/packImport:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/packImport:result`, create: _statusResult },
				},

				{
					id: `${PKG}#weixin/personaOverview`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaOverview",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/personaOverview:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaOverview:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/personaModeSave`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaModeSave",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/personaModeSave:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaModeSave:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/personaExport`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaExport",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaExport:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/personaImport`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaImport",
					invocation: { kind: "direct" },
					parameters: [{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/personaImport:p0`, create: _strMap } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaImport:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/personaModeRemove`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaModeRemove",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "modeId", wire: "modeId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/personaModeRemove:p0`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaModeRemove:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/personaDefaultSet`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaDefaultSet",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "modeId", wire: "modeId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/personaDefaultSet:p0`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaDefaultSet:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/personaAccountDefaultSet`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaAccountDefaultSet",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/personaAccountDefaultSet:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaAccountDefaultSet:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/personaOverrideClear`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "personaOverrideClear",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/personaOverrideClear:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/personaOverrideClear:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/memoryEventAdd`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "memoryEventAdd",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryEventAdd:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryEventAdd:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/memoryEventDone`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "memoryEventDone",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryEventDone:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryEventDone:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/memoryEventRemove`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "memoryEventRemove",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryEventRemove:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryEventRemove:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/memoryProfileSave`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "memoryProfileSave",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryProfileSave:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryProfileSave:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/memoryFactAdd`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "memoryFactAdd",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryFactAdd:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryFactAdd:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/memoryFactRemove`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "memoryFactRemove",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryFactRemove:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryFactRemove:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/memoryConvClear`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "memoryConvClear",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "options", wire: "options", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryConvClear:p0`, create: _strMap } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/memoryConvClear:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/removeSession`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "removeSession",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "conversationId", wire: "conversationId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/removeSession:p0`, create: _str } },
						{ name: "index", wire: "index", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/removeSession:p1`, create: _num } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/removeSession:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/pause`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "pause",
					invocation: { kind: "direct" },
					parameters: [{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/pause:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/pause:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/resume`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "resume",
					invocation: { kind: "direct" },
					parameters: [{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/resume:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/resume:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/label`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "label",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/label:p0`, create: _str } },
						{ name: "text", wire: "text", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/label:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/label:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixin/allowlist`,
					service: "weixinLoginController",
					namespace: "weixin",
					method: "allowlist",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "accountId", wire: "accountId", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:p0`, create: _str } },
						{ name: "senders", wire: "senders", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:p1`, create: _str } },
						{ name: "chats", wire: "chats", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:p2`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixin/allowlist:result`, create: _statusResult },
				},
				// weixinAsr namespace (AsrController)
				{
					id: `${PKG}#weixinAsr/listModels`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "listModels",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/listModels:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/setModelDir`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "setModelDir",
					invocation: { kind: "direct" },
					parameters: [{ name: "dir", wire: "dir", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setModelDir:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setModelDir:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/downloadModel`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "downloadModel",
					invocation: { kind: "direct" },
					parameters: [{ name: "repo", wire: "repo", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadModel:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadModel:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/downloadStatus`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "downloadStatus",
					invocation: { kind: "direct" },
					parameters: [{ name: "repo", wire: "repo", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadStatus:p0`, create: _str } }],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/downloadStatus:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/getDownloadSettings`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "getDownloadSettings",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/getDownloadSettings:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinAsr/setDownloadSettings`,
					service: "asrController",
					namespace: "weixinAsr",
					method: "setDownloadSettings",
					invocation: { kind: "direct" },
					// `wire` MUST equal the parameter name. Two parameters may not
					// share a wire field, so a second `wire: "input"` would throw
					// at mount time and take the whole plugin down with it.
					parameters: [
						{ name: "endpoint", wire: "endpoint", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setDownloadSettings:p0`, create: _str } },
						{ name: "proxy", wire: "proxy", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setDownloadSettings:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinAsr/setDownloadSettings:result`, create: _statusResult },
				},
				// weixinConfig namespace (ConfigController) — the options form.
				{
					id: `${PKG}#weixinConfig/list`,
					service: "configController",
					namespace: "weixinConfig",
					method: "list",
					invocation: { kind: "direct" },
					parameters: [],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/list:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinConfig/save`,
					service: "configController",
					namespace: "weixinConfig",
					method: "save",
					invocation: { kind: "direct" },
					// The batch is a JSON string, not a structured array: the wire
					// validates each parameter against a declared codec and this
					// plugin's codec vocabulary has no array node, so an array
					// parameter would be refused before the method ran.
					parameters: [
						{ name: "entriesJson", wire: "entriesJson", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/save:p0`, create: _str } },
						{ name: "lang", wire: "lang", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/save:p1`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/save:result`, create: _statusResult },
				},
				{
					id: `${PKG}#weixinConfig/reset`,
					service: "configController",
					namespace: "weixinConfig",
					method: "reset",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "pathsJson", wire: "pathsJson", source: "json", codec: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/reset:p0`, create: _str } },
					],
					result: { mode: "strict", typeSymbol: `${PKG}#weixinConfig/reset:result`, create: _statusResult },
				},
			],
		};

		//#region UI components

		/** Outcome of a chooser attempt, so the caller can say what happened. */
		const PICK_CANCELLED = "cancelled";
		const PICK_UNAVAILABLE = "unavailable";

		/**
		 * Where models may be downloaded from.
		 *
		 * The mirror first because the official site is unreachable on a
		 * degraded international route while the mirror works — measured on this
		 * machine: huggingface.co completes a TCP handshake and then transfers
		 * nothing, and its weight CDN does not answer at all.
		 *
		 * `custom` carries no endpoint: it exists so the radio group can show
		 * that an endpoint set elsewhere is in effect, and choosing it is a
		 * no-op rather than a silent reset to a default.
		 */
		const SOURCE_CHOICES = [
			{
				id: "mirror",
				endpoint: "https://hf-mirror.com",
				labelZh: "国内镜像（推荐）",
				labelEn: "Mirror (recommended)",
			},
			{
				id: "official",
				endpoint: "https://huggingface.co",
				labelZh: "官方站 huggingface.co",
				labelEn: "Official huggingface.co",
			},
			{ id: "custom", endpoint: "", labelZh: "自定义地址", labelEn: "Custom" },
		];

		/**
		 * Whether the download goes through a proxy.
		 *
		 * `direct` is the default because it is what works on an unproxied
		 * network; naming a proxy when there is none breaks a download that
		 * would otherwise have succeeded.
		 */
		const PROXY_CHOICES = [
			{
				id: "direct",
				labelZh: "直连",
				labelEn: "Direct",
				hintZh: "不使用代理",
				hintEn: "No proxy",
			},
			{
				id: "custom",
				labelZh: "使用代理",
				labelEn: "Use a proxy",
				hintZh: "例如 http://127.0.0.1:7897",
				hintEn: "e.g. http://127.0.0.1:7897",
			},
		];

		/**
		 * Open the host's native directory chooser.
		 *
		 * The shell mounts the workspace controller's `directoryPicker` Remote on
		 * every platform — the web client's platform-neutral assembly calls
		 * `$mount` for it — so the Remote is the ordinary path:
		 *
		 *  1. `ctx.remote.directoryPicker.pick()` — the ordinary path.
		 *  2. `globalThis.__DSH_DIRECTORY_PICKER__.pick()` — the Electron IPC
		 *     bridge. It is injected only when `location.protocol` is
		 *     `dsh-app:`, so on the http Web GUI it is absent by design.
		 *
		 * `ctx` MUST be a context that declares `remote.directoryPicker`. Every
		 * namespace is its own Cordis service, and reading an undeclared service
		 * yields `undefined` silently rather than throwing — which is exactly how
		 * a mounted picker came to look absent.
		 *
		 * Returns `{ok: true, path}` with a real path, `{ok: false, reason}`
		 * with PICK_CANCELLED when the operator dismissed the dialog, or
		 * PICK_UNAVAILABLE when nothing could be reached. Cancelling is not an
		 * error, but it must not be reported as a missing capability: collapsing
		 * the two is what made a working chooser look broken.
		 */
		async function pickDirectory(ctx) {
			const picker = ctx.remote?.directoryPicker;
			if (picker?.pick !== undefined) {
				try {
					// `pick` takes no positional arguments. Its descriptor is
					// `parameters: []` with `cancellation: {parameter: "signal"}`,
					// so the signal travels on the call options, never as arg 0.
					const path = unwrap(await picker.pick());
					return typeof path === "string" && path !== ""
						? { ok: true, path }
						: { ok: false, reason: PICK_CANCELLED };
				} catch (error) {
					// Dismissing the dialog is reported as a cancellation. Any
					// other failure is a real fault and falls through so the
					// bridge, when present, still gets its chance.
					if (isCancellation(error)) return { ok: false, reason: PICK_CANCELLED };
				}
			}
			const bridge = globalThis.__DSH_DIRECTORY_PICKER__;
			if (bridge?.pick !== undefined) {
				try {
					const path = await bridge.pick();
					return typeof path === "string" && path !== ""
						? { ok: true, path }
						: { ok: false, reason: PICK_CANCELLED };
				} catch {
					return { ok: false, reason: PICK_UNAVAILABLE };
				}
			}
			return { ok: false, reason: PICK_UNAVAILABLE };
		}

		/**
		 * Unwrap a Remote invocation result.
		 *
		 * Every client Remote call resolves to an envelope — `{ok: true, value}`
		 * on success, `{ok: false, error}` for a withdrawal, cancellation or
		 * carrier fault — never to the bare host return value. Reading the host
		 * fields straight off that envelope yields `undefined` for everything,
		 * which is what made the QR image and the model list render empty.
		 */
		function unwrap(result) {
			if (result !== null && typeof result === "object" && "ok" in result) {
				if (!result.ok) throw result.error ?? new Error("remote call failed");
				return result.value;
			}
			// Already bare (older carrier, or a stubbed call in tests).
			return result;
		}

		/** Call a Remote method and return its unwrapped host value. */
		async function callRemote(fn, ...args) {
			return unwrap(await fn(...args));
		}

		/**
		 * Whether a Remote failure is a cancellation rather than a fault.
		 *
		 * The carrier reports a withdrawn and a cancelled invocation through the
		 * same `{ok: false, error}` envelope, distinguished only by the error
		 * code, so the code is what has to be read. Dismissing a file dialog is
		 * an ordinary outcome and must not be shown as a failure.
		 */
		function isCancellation(error) {
			const code = error?.code ?? error?.name;
			return code === "cancelled" || code === "canceled" || code === "aborted" || code === "AbortError";
		}

		function useLocaleText(ctx) {
			// Simple bilingual labels without the locale dictionaries: the plugin
			// card stays self-contained and reads the client's current language.
			//
			// The service DSH actually provides exposes `getSnapshot()` /
			// `getLocale()` returning `{ active: "zh" | "en", ... }`, plus
			// `resolveText()`. There is no `locale.current.language`, which is what
			// this used to read -- so on an English client every lookup fell
			// through to the `"zh"` default and the card rendered Chinese next to
			// an English shell. The older shapes are kept as fallbacks because
			// this plugin is installed into whatever DSH the user runs, and the
			// service is not versioned with it.
			const snapshot = ctx.locale?.getSnapshot?.() ?? ctx.locale?.getLocale?.();
			// `locale.current` is a function on some hosts and an object on others,
			// so accept either rather than picking up the function itself.
			const rawCurrent = typeof ctx.locale?.current === "function" ? ctx.locale.current() : ctx.locale?.current;
			const lang =
				snapshot?.active ??
				(typeof rawCurrent === "string" ? rawCurrent : rawCurrent?.language) ??
				ctx.locale?.language ??
				"zh";
			const zh = typeof lang === "string" && lang.toLowerCase().startsWith("zh");
			return {
				lang,
				t: (en, zhText) => (zh ? zhText : en),
			};
		}

		//#region design vocabulary

		/**
		 * The host's design tokens, so this card follows the app's light and dark
		 * themes instead of hardcoding colors that only work in one of them.
		 *
		 * The fallbacks are the light-theme values, and they matter: a token the
		 * running shell does not define would otherwise resolve to nothing and
		 * render as `transparent`/`inherit`, i.e. invisible text on some themes.
		 */
		const C = {
			labelPrimary: "var(--dsw-alias-label-primary, #1f2329)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			labelTertiary: "var(--dsw-alias-label-tertiary, #9aa0a6)",
			border: "var(--dsw-alias-border-l2)",
			surface: "var(--dsw-alias-bg-layer-1, #fff)",
			surfaceSunken: "var(--dsw-alias-bg-layer-2, #f6f7f9)",
			moduleFill: "var(--dsw-alias-bg-module-platform)",
			brand: "var(--dsw-alias-brand-primary)",
			primaryFill: "var(--dsw-alias-button-primary-fill)",
			onPrimary: "var(--dsw-alias-label-primary-foreground)",
			success: "var(--dsw-alias-state-success-primary, #22a06b)",
			successSubtle: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			danger: "var(--dsw-alias-state-error-primary, #d92d20)",
			warn: "var(--dsw-alias-state-warn-primary, #d97706)",
			warnSubtle: "var(--dsw-alias-state-warn-tertiary, #fff4e5)",
			idle: "var(--dsw-alias-label-dimmed, #9aa0a6)",
			hover: "var(--dsw-alias-interactive-bg-hover)",
		};

		const RADIUS = { card: 12, control: 8, pill: 999 };

		/** A panel that groups related controls, matching the host's own cards. */
		const panelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "13px 15px",
			border: `1px solid ${C.border}`,
			borderRadius: RADIUS.card,
			background: C.moduleFill,
			color: C.labelPrimary,
		};

		/** Secondary text: real token color, not a faded primary. */
		const hintStyle = { margin: 0, fontSize: 13, lineHeight: "20px", color: C.labelSecondary };
		const captionStyle = { margin: 0, fontSize: 12, lineHeight: "18px", color: C.labelTertiary };

		/** The card's own section heading inside a panel. */
		const panelTitleStyle = { margin: 0, fontSize: 14, lineHeight: "20px", fontWeight: 600, color: C.labelPrimary };

		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			boxSizing: "border-box",
			minHeight: 32,
			padding: "4px 12px",
			border: `1px solid ${C.border}`,
			borderRadius: RADIUS.control,
			background: C.surface,
			color: C.labelPrimary,
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			whiteSpace: "nowrap",
			cursor: "pointer",
		};
		const primaryButtonStyle = {
			...buttonStyle,
			borderColor: C.primaryFill,
			background: C.primaryFill,
			color: C.onPrimary,
		};
		/** `:disabled` cannot be expressed inline, so callers pass the flag. */
		const buttonStyleFor = (disabled) => (disabled ? { ...buttonStyle, opacity: 0.5, cursor: "default" } : buttonStyle);

		const inputStyle = {
			boxSizing: "border-box",
			flex: 1,
			minWidth: 0,
			minHeight: 32,
			padding: "4px 10px",
			border: `1px solid ${C.border}`,
			borderRadius: RADIUS.control,
			background: C.surface,
			color: C.labelPrimary,
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
		};

		/**
		 * A status dot.
		 *
		 * Color alone must not carry the meaning, so every caller pairs this with
		 * a label; the dot is what makes the state scannable at a glance.
		 */
		function dotStyle(kind) {
			return {
				width: 9,
				height: 9,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: kind === "ok" ? C.success : kind === "bad" ? C.danger : kind === "warn" ? C.warn : C.idle,
			};
		}

		/** A small pill for a state worth calling out, e.g. "expired". */
		function pillStyle(kind) {
			const bad = kind === "bad";
			return {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				padding: "1px 8px",
				borderRadius: RADIUS.pill,
				fontSize: 12,
				lineHeight: "18px",
				background: bad ? "var(--dsw-alias-state-error-subtle, rgba(217, 45, 32, 0.12))" : C.successSubtle,
				color: bad ? C.danger : C.success,
				whiteSpace: "nowrap",
			};
		}

		/** An inline notice for a problem the operator has to act on. */
		const noticeStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 9,
			padding: "10px 12px",
			border: `1px solid ${C.warn}`,
			borderRadius: RADIUS.control,
			background: C.warnSubtle,
			color: C.labelPrimary,
			fontSize: 13,
			lineHeight: "20px",
		};

		// A determinate bar reads as measured progress; it is only rendered when
		// the CLI actually reported a percentage, never as decoration.
		const progressTrackStyle = {
			height: 6,
			borderRadius: RADIUS.pill,
			background: C.surfaceSunken,
			overflow: "hidden",
			maxWidth: 320,
		};

		const progressFillStyle = {
			height: "100%",
			borderRadius: RADIUS.pill,
			background: C.brand,
			transition: "width 240ms ease",
		};

		//#endregion design vocabulary

		// react.createElement binding (JSX-free)
		const createElement = react.createElement;

		//#endregion

		// ----------------------------------------------------- session row mark --

		// The WeChat mark a Session row leads with, on the Sessions this plugin
		// opened. The `sidebar.session.row.leading` seat (declared by
		// ui-workspace — the same seat ui-schedule's clock occupies) renders only
		// while the row's primary status is idle and is left blank on an archived
		// row; search results have no leading seat at all. The seat receives the
		// row's Session identity and nothing else, so the occupant decides from
		// `sessionId` alone.
		//
		// Only *our* Sessions carry the mark. `baseSessionIdFor` mints
		// `weixin-<slug>`, and a new line appends `--<stamp>`; an ordinary
		// workspace Session keeps its unrelated `session-<uuid>` id, so a prefix
		// test shows the mark exactly where WeChat opened the conversation — and
		// never on someone else's rows.
		const SESSION_ID_PREFIX = "weixin-";

		// WeChat's own logo: the simple-icons "WeChat" path (24x24 viewBox) — the
		// same glyph the host draws for `weixin.qq.com` links, so this mark and a
		// WeChat link in a transcript read as one identity. Kept inline because
		// the client bundle may only require `react` and `react/jsx-runtime`; a
		// glyph module is not on that list.
		const WECHAT_GLYPH = "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z";

		// WeChat green, the brand's own value. The `--dsw-alias-state-success-*`
		// tokens sit near it but are the interface's "everything is fine" green
		// rather than WeChat's, and a brand mark that shifts with the shell's
		// state palette stops being a brand mark.
		const WECHAT_GREEN = "#07C160";

		// The left sidebar's panel list (`sidebar.panellist`) and the page that
		// row opens (the layout's root-scoped `main` keyed slot) are addressed by
		// the SAME id: the host looks the page up by the row's id, and a row
		// whose id has no `main` entry throws on click without moving the
		// selection. The id also has to stay clear of the shell's own panels
		// (`conversation`, `plugins`, `schedules`), so the package name is it.
		const PANEL_ID = "dsh-weixin";

		/** Whether a Session id belongs to a conversation this plugin opened. */
		function isWeixinSession(sessionId) {
			return typeof sessionId === "string" && sessionId.startsWith(SESSION_ID_PREFIX);
		}

		// Which account a session line belongs to, for the faint ownership hint
		// on the sidebar row. Only `sessions()` knows the line→account mapping
		// (the session id's slug is the CONVERSATION's, not the account's, so it
		// cannot be derived from the id), and the row seat renders for every
		// session on screen, so the mapping is fetched once per mount and cached
		// module-wide: the seat must stay cheap, and a failed fetch must never
		// break the row — the hint is a hint, not a feature the row depends on.
		let sessionOwnerMap = null; // Map<sessionId, {accountId, accountLabel}>
		let sessionOwnerFetched = false;
		// The seat's occupant receives only the row's Session identity — no
		// injection context — so registerUi parks its ctx here for the fetch.
		let sessionOwnerCtx = null;

		async function loadSessionOwners(ctx) {
			if (sessionOwnerFetched) return sessionOwnerMap;
			sessionOwnerFetched = true;
			try {
				const data = await callRemote(() => ctx.remote.weixin.sessions());
				const map = new Map();
				for (const conversation of data?.conversations ?? []) {
					if (typeof conversation?.accountId !== "string" || conversation.accountId === "") continue;
					for (const line of conversation.lines ?? []) {
						if (typeof line?.sessionId === "string") {
							map.set(line.sessionId, { accountId: conversation.accountId, accountLabel: conversation.accountLabel ?? null });
						}
					}
				}
				console.error("MAP BUILT size=" + map.size);
							sessionOwnerMap = map;
			} catch {
				// Remote not mounted yet, or the host refused: render no hint.
				sessionOwnerMap = null;
			}
			return sessionOwnerMap;
		}

		/** At most 6 visible characters, then an ellipsis, per the card's spec. */
		function ownerHintText(text) {
			const chars = Array.from(typeof text === "string" ? text : "");
			return chars.length <= 6 ? text : chars.slice(0, 6).join("") + "…";
		}

		/**
		 * The faint account hint beside the WeChat mark. Reads the cached
		 * session→owner map; sessions it cannot attribute (pre-multi-account
		 * history, a mapping not loaded yet) render no hint at all. The seat
		 * passes no ctx, so the hook falls back to the one registerUi parked.
		 */
		function useSessionOwner(sessionId) {
			const [owner, setOwner] = react.useState(() => sessionOwnerMap?.get(sessionId) ?? null);
			react.useEffect(() => {
				if (!sessionOwnerCtx) return undefined;
				let alive = true;
				loadSessionOwners(sessionOwnerCtx).then((map) => {
					console.error("THEN alive=" + alive + " hit=" + !!map?.get(sessionId));
								if (alive) setOwner(map?.get(sessionId) ?? null);
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, [sessionId]);
			return owner;
		}

		/**
		 * The row mark for one of this plugin's Sessions.
		 *
		 * Returns `null` for every other Session, which is the whole point: the
		 * seat is shared with the host's own marks, so an occupant that claimed
		 * every row would stamp the WeChat logo on unrelated conversations.
		 * Decorative only — the seat is not a button and has no tab stop, so the
		 * glyph is `aria-hidden` and carries no label of its own.
		 *
		 * @param props.sessionId - the row's Session identity.
		 * @returns the glyph, or `null` for a Session this plugin did not open.
		 */
		function SessionRowMark({ sessionId }) {
			if (!isWeixinSession(sessionId)) return null;
			// Ownership moved INTO the title (`备注名: 标题`, see titledWithAccount
			// in sessions.js) after two hint-element attempts were squeezed by the
			// host's row — text inside the title flows, nothing competes for
			// width. The mark is the plain glyph again; useSessionOwner and the
			// owner fetch stay (the card still reads attribution), only the row
			// hint element is gone.
			return createElement("span", {
					className: "weixin-session-row-mark",
					"aria-hidden": "true",
					style: { display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", gap: 4 },
				},
				createElement("svg", {
					width: 14,
					height: 14,
					viewBox: "0 0 24 24",
					fill: WECHAT_GREEN,
					focusable: "false",
					"aria-hidden": "true",
					style: { flex: "none" },
				}, createElement("path", { d: WECHAT_GLYPH })));
		}

		// This list must NOT name the namespaces: `remote.weixin` only comes into
		// existence inside apply() when $mount installs it, so waiting for it here
		// is a deadlock — the boot audit reports
		// `pending (waiting for services: remote.weixin, remote.weixinAsr)`.
		// `remote` itself is safe because the api-gateway provides it before any
		// bundle activates. The namespaces are declared on the inner ctx.inject
		// below, which runs after $mount has created them.
		const inject = ["remote", "slots", "locale"];

		async function registerUi(ctx) {
			const { t } = useLocaleText(ctx);
			// Park the ui context for the row-mark's owner fetch: the seat hands
			// its occupant the Session identity only, so the hint hook has no ctx
			// of its own to read remote.weixin.sessions() through.
			sessionOwnerCtx = ctx;
			const actions = {
				noop: async () => {},
			};

			// The same card twice, in two homes: the plugin's own bundle page
			// (plugins.bundle.config) and the shell Settings navigation
			// (settings.section — the slot dsh-im uses for its「IM机器人」page).
			// One component, two registrations, so the copy never forks.
			// The card itself lives in a package-local lazy chunk (src/client.card.js):
			// the shell loads this bundle on every page, and only two slots ever render
			// a card. The chunk is fetched during activation, before these slots are
			// registered, so the first render is still synchronous and a failed chunk
			// reports itself where the card would have been instead of a blank page.
			let cardModule = null;
			let cardLoadError = "";

			async function ensureCardModule() {
				if (cardModule !== null || cardLoadError !== "") return;
				try {
					const loaded = await require.async("./client.card.js");
					cardModule = loaded.createCardModule({
						// Names the card needs that also belong to the entry: the
						// package id and version, the remote helper, and the ASR
						// picker's option tables. Everything else it needs is a
						// design token, passed below.
						PKG,
						PLUGIN_VERSION,
						callRemote,
						PICK_UNAVAILABLE,
						SOURCE_CHOICES,
						PROXY_CHOICES,
						ctx,
						t,
						createElement,
						C,
						RADIUS,
						panelStyle,
						hintStyle,
						captionStyle,
						panelTitleStyle,
						buttonStyle,
						buttonStyleFor,
						primaryButtonStyle,
						inputStyle,
						dotStyle,
						pillStyle,
						noticeStyle,
						progressTrackStyle,
						progressFillStyle,
						unwrap,
						isCancellation,
						useLocaleText,
						pickDirectory,
					});
				} catch (error) {
					cardLoadError = String((error && error.message) || error);
				}
			}

			// The same card twice, in two homes: the plugin's own bundle page
			// (plugins.bundle.config) and the shell Settings navigation
			// (settings.section — the slot dsh-im uses for its「IM机器人」page).
			// One component, two registrations, so the copy never forks.
			function WeixinSettingsCard() {
				if (cardLoadError !== "") {
					return createElement("div", { style: noticeStyle },
						createElement("span", { style: { flex: "0 0 auto" } }, "⚠"),
						createElement("span", null,
							"设置卡没加载上：", cardLoadError,
							"（插件包里的 client.card.js 缺失或被运行时拒绝）"));
				}
				if (cardModule === null) {
					return createElement("p", { style: captionStyle }, "正在加载设置卡…");
				}
				return createElement(cardModule.WeixinSettingsCard, {});
			}


			// The glyph in the left sidebar's panel list. The host renders it at
			// 16px in the expanded column and 18px in the collapsed rail, and
			// passes `active`; only the size is ours to honour, since the row
			// itself owns the hover/selected background. `aria-hidden` because
			// the row's label is the accessible name.
			function WeixinPanelGlyph({ size = 16 } = {}) {
				return createElement("svg", {
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: WECHAT_GREEN,
					focusable: "false",
					"aria-hidden": "true",
					style: { flex: "none" },
				}, createElement("path", { d: WECHAT_GLYPH }));
			}

			// The page behind that row: the same card, but it owns the whole
			// workspace area instead of a settings modal. Without the wrapper the
			// card would stretch to the window width (its rows are full-bleed)
			// and start flush against the frame edges, so the page supplies a
			// gutter, a readable measure, and its own scroll — the card was sized
			// for a ~520px dialog, not for a full pane.
			function WeixinPanelPage() {
				return createElement("div", {
						style: { height: "100%", overflowY: "auto", boxSizing: "border-box", padding: "24px 28px 56px" },
					},
					createElement("div", { style: { maxWidth: 920, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 } },
						createElement(WeixinSettingsCard, {})));
			}

			// The left sidebar entry. `sidebar.panellist` draws the row (glyph
			// plus, when expanded, this label) and the host looks the page up in
			// the root-scoped `main` keyed slot by the same id, so the two
			// registrations are one feature and must stay in step. Order 20 sits
			// after the shell's Plugins (0) and dsh-schedule's task manager (10):
			// all three are workspace-level pages rather than conversations, and
			// a WeChat account is not more routine than either of them.
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
						locale: NS,
						inject: () => actions,
					},
					WeixinPanelPage));

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 20,
						label: () => t("WeChat", "微信"),
						locale: NS,
					},
					WeixinPanelGlyph));

			ctx.slots.inject("plugins.bundle.config", () =>
				ctx.slots.register(
					{
						name: "plugins.bundle.config",
						key: PKG,
						locale: NS,
						inject: () => actions,
					},
					WeixinSettingsCard));

			// The shell Settings modal: one nav entry opening the same card.
			// `label` is a locale thunk so switching the interface language
			// renames the entry without a reload (the navigation re-renders on
			// the section ledger bump). Order 22 sits just after dsh-im's 21.
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: `${PKG}-settings`,
						order: 22,
						label: () => t("WeChat", "微信"),
						locale: NS,
						inject: () => actions,
					},
					WeixinSettingsCard));

			// The session row mark. ui-workspace declares this seat on every
			// Session row and renders it only while the row is idle, so the
			// occupant is asked about rows it has nothing to do with — hence
			// `SessionRowMark` returning `null` rather than an empty glyph.
			// Order 20 sits after ui-schedule's 10: when a WeChat Session also
			// has an active scheduled task the host's clock still leads, and
			// the mark follows it instead of competing for the same cell.
			ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register(
					{
						name: "sidebar.session.row.leading",
						id: `${PKG}-row-mark`,
						order: 20,
						locale: NS,
						inject: () => actions,
					},
					SessionRowMark));

			// Fetch the chunk here, at activation, not on first paint: apply()
			// awaits this registration, so the shell never sees a "loading" card.
			await ensureCardModule();
		}

		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			// Every namespace is its own Cordis service, so each one the card
			// reaches for must be named here. Reading an undeclared service
			// returns `undefined` instead of throwing, so a missing entry does
			// not fail loudly — it silently downgrades a working feature, which
			// is how the directory chooser came to report itself absent.
			// `remote.directoryPicker` belongs to the shell's own assembly, not
			// to this plugin, so it needs the same explicit declaration.
			const ui = ctx.inject(
				["remote.weixin", "remote.weixinAsr", "remote.weixinConfig", "remote.directoryPicker", "slots", "locale"],
				registerUi,
			);
			try {
				await ui;
			} catch (error) {
				await ui.dispose();
				await disposeRemote();
				throw error;
			}
			return async () => {
				await ui.dispose();
				await disposeRemote();
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		// The sidebar panel's id: the row and the page are two registrations
		// that only work while they agree, so the tests assert both seats carry
		// this exact id rather than a copy of the literal.
		exports.PANEL_ID = PANEL_ID;
		// Exported for the test suite: the chooser's cancel/absent-profile paths
		// are the ones that regress silently, and they are not reachable from the
		// component tree without a DOM.
		exports.pickDirectory = pickDirectory;
		return module.exports;
	}
});
