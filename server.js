"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var app_1 = require("@octokit/app");
var webhooks_1 = require("@octokit/webhooks");
var http_1 = require("http");
var tiny_invariant_1 = require("tiny-invariant");
// --- env ---
var _a = process.env, APP_ID = _a.APP_ID, PRIVATE_KEY = _a.PRIVATE_KEY, // PEM content
WEBHOOK_SECRET = _a.WEBHOOK_SECRET, _b = _a.PORT, PORT = _b === void 0 ? "3000" : _b;
(0, tiny_invariant_1.default)(APP_ID, "APP_ID required");
(0, tiny_invariant_1.default)(PRIVATE_KEY, "PRIVATE_KEY required");
(0, tiny_invariant_1.default)(WEBHOOK_SECRET, "WEBHOOK_SECRET required");
// Octokit App (used to auth as installation per repo)
var app = new app_1.App({ appId: APP_ID, privateKey: PRIVATE_KEY });
// Webhooks verifier/dispatcher
var webhooks = new webhooks_1.Webhooks({ secret: WEBHOOK_SECRET });
function pushSgcProduction(payload) {
    return __awaiter(this, void 0, void 0, function () {
        var installationId, owner, repo, octokit, e_1;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    installationId = (_a = payload.installation) === null || _a === void 0 ? void 0 : _a.id;
                    owner = payload.repository.owner.login;
                    repo = payload.repository.name;
                    return [4 /*yield*/, app.getInstallationOctokit(installationId)];
                case 1:
                    octokit = _b.sent();
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, octokit.request("POST /repos/{owner}/{repo}/merges", {
                            owner: owner,
                            repo: repo,
                            base: "production",
                            head: "sgc-production"
                            // merge_method not supported here; this API does FF or merge commit automatically
                        })];
                case 3:
                    _b.sent();
                    console.log("[".concat(owner, "/").concat(repo, "] merged sgc-production -> production"));
                    return [2 /*return*/];
                case 4:
                    e_1 = _b.sent();
                    // 409 means not fast-forwardable; fall back to PR
                    if (e_1.status !== 409)
                        throw e_1;
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// Core reaction: when sgc-production changes, do something
webhooks.on("push", function (_a) { return __awaiter(void 0, [_a], void 0, function (_b) {
    var _c;
    var payload = _b.payload;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0:
                _c = payload.ref;
                switch (_c) {
                    case "refs/heads/sgc-production": return [3 /*break*/, 1];
                }
                return [3 /*break*/, 4];
            case 1:
                if (!!payload.deleted) return [3 /*break*/, 3];
                return [4 /*yield*/, pushSgcProduction(payload)];
            case 2:
                _d.sent();
                _d.label = 3;
            case 3: return [3 /*break*/, 5];
            case 4: return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); });
// Minimal Node server + webhook middleware
var server = http_1.default.createServer(function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        return [2 /*return*/, (0, webhooks_1.createNodeMiddleware)(webhooks, { path: "/" })(req, res)];
    });
}); });
server.listen(Number(PORT), function () {
    console.log("Webhook server listening on :".concat(PORT));
});
