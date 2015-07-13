var server;

export function initLogging(hapiServer:any) {
    server = hapiServer;
}


export function log(...args:any[]) {
    if (!server) {
        console.error('Server not initialized for logging');
        return;
    }

    if (args.length > 1) {
        server.log(['ark-realtime'], args[0] + ': ' + args.splice(1).join(''));
    } else {
        server.log(['ark-realtime'], args[0]);
    }
}
export function logErr(...args:any[]) {
    if (!server) {
        console.error('Server not initialized for logging');
        return;
    }

    if (args.length > 1) {
        server.log(['ark-realtime', 'Error'], args[0] + ': ' + args.splice(1).join(''));
    } else {
        server.log(['ark-realtime', 'Error'], args[0]);
    }
}