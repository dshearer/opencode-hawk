import type { Plugin } from '@opencode-ai/plugin';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import {
    Application,
    Message,
    NotifyServiceClient,
    InfoServiceClient,
    PermissionServiceClient,
    WantsToCallToolRequest,
    WillCallToolRequest,
    DidCallToolRequest,
} from "@dshearer/modelhawk";


class DenyTool extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DenyTool";
    }
}

function packageArgs(args: any): { [key: string]: string } {
    const newArgs: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(args)) {
        newArgs[key] = String(value);
    }
    return newArgs;
}

async function getLastMessages(client: OpencodeClient, sessionID: string, n: number): Promise<Message[]> {
    const resp = await client.session.messages({ path: { id: sessionID } });
    if (resp.error !== undefined) {
        throw new Error(`failed to get session messages: ${resp.error}`);
    }

    // TODO: not sure if the messages are already sorted
    resp.data.sort((a, b) => {
        if (a.info.time.created < b.info.time.created) {
            return -1;
        }
        if (a.info.time.created > b.info.time.created) {
            return 1;
        }
        return 0;
    });

    const messages: Message[] = [];
    resp.data.slice(-n).forEach(m => {
        messages.push({
            role: m.info.role,
            content: JSON.stringify(m.parts),
        });
    });
    return messages;
}

export const ModelHawkClient: Plugin = async ({ client, directory }) => {
    async function log(level: "debug" | "info" | "error" | "warn", msg: string) {
        const logService = "opencode-hawk";
        await client.app.log({ body: { service: logService, level: level, message: msg } })
    }

    await log("info", "started");

    // get setttings
    const port = Number(process.env.OPENCODE_HAWK_DEST_PORT) || 50051;
    const hn = process.env.OPENCODE_HAWK_DEST_HOST || "localhost";
    const appValue = process.env.OPENCODE_HAWK_APP || "opencode";

    const app: Application = { value: appValue };
    const reportedTools = new Set<string>();
    const failClosed = true;
    const lastNMessages = 5;

    // Create a gRPC transport pointing at your server
    const transport = new GrpcTransport({
        host: `${hn}:${port}`,
        channelCredentials: ChannelCredentials.createInsecure(),
    });

    // make clients
    const notifyClient = new NotifyServiceClient(transport);
    const infoClient = new InfoServiceClient(transport);
    const permissionClient = new PermissionServiceClient(transport);

    async function handleError(e: any) {
        await log("error", `error: ${e}`)
    }

    return {
        "tool.execute.before": async (input, output) => {
            try {
                if (!reportedTools.has(input.tool)) {
                    // tell the ModelHawk server about the tool
                    await infoClient.giveToolInfo({
                        app: app, name: input.tool, args: [],
                    });
                    reportedTools.add(input.tool);
                }

                // get last messages
                const lastMessages = await getLastMessages(client, input.sessionID, lastNMessages);

                // ask the ModelHawk server if we may call the tool
                const req1: WantsToCallToolRequest = { app: app, toolName: input.tool, args: packageArgs(output.args), lastMessages: lastMessages };
                const resp = await permissionClient.wantsToCallTool(req1);
                switch (resp.response.permitted) {
                case true:
                    break;
                case false:
                    throw new DenyTool("ModelHawk server says 'no'");
                default:
                    if (failClosed) {
                        throw new DenyTool("Did not get response from ModelHawk server. Failing closed.");
                    }
                }

                // tell the ModelHawk server that we will call the tool
                const req2: WillCallToolRequest = { app: app, toolName: input.tool, args: packageArgs(output.args), lastMessages: lastMessages };
                await notifyClient.willCallTool(req2);

            } catch (e) {
                if (e instanceof DenyTool) {
                    throw e;
                }
                await handleError(e);
            }
        },

        "tool.execute.after": async (input, output) => {
            try {
                if (!reportedTools.has(input.tool)) {
                    // tell the ModelHawk server about the tool
                    await infoClient.giveToolInfo({
                        app: app, name: input.tool, args: [],
                    });
                    reportedTools.add(input.tool);
                }

                // get last messages
                const lastMessages = await getLastMessages(client, input.sessionID, lastNMessages);

                // tell the ModelHawk server that we called the tool
                const req: DidCallToolRequest = { app: app, toolName: input.tool, args: packageArgs(input.args), result: JSON.stringify(output), lastMessages: lastMessages };
                await notifyClient.didCallTool(req);

            } catch (e) {
                await handleError(e);
            }
        },
    };
};