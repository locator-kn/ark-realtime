export interface IRegister {
    (server:any, options:any, next:any): void;
    attributes?: any;
}

export default
class Realtime {
    socketio:any;
    io:any;
    stats:any = {};

    namespaces = {};

    USER_ONLINE_EVENT:string = 'new_user_online';
    USER_OFFLINE_EVENT:string = 'user_went_offline';

    CLIENT_EVENTS:any = {
        NEW_MESSAGE: 'new_message'
    };

    constructor() {
        this.register.attributes = {
            pkg: require('./../../package.json')
        };

        this.socketio = require('socket.io');
    }

    register:IRegister = (server, options, next) => {
        //server = server.select('realtime');
        server.bind(this);
        this._register(server, options);

        this.io = this.socketio(server.listener);
        this.createStatsNamespace();
        this.exportApi(server);
        next();
    };

    createStatsNamespace() {
        this.stats.ns = this.io.of('/stats');
        this.stats.usersOnline = 0;
    }

    userChange(user, wentOnline:boolean) {
        if (wentOnline) {
            this.stats.usersOnline++;
            this.stats.ns.emit(this.USER_ONLINE_EVENT, {user: user, usersOnline: this.stats.usersOnline});
        } else {
            this.stats.usersOnline--;
            this.stats.ns.emit(this.USER_OFFLINE_EVENT, {user: user, usersOnline: this.stats.usersOnline});
        }
    }

    private _register(server, options) {
        server.route({
            method: 'GET',
            path: '/connect/me',
            config: {
                handler: (request, reply) => {
                    var userId:string = request.auth.credentials._id;
                    this.createNameSpace(userId);
                    reply({
                        message: 'namespace created: ' + userId,
                        namespace: '/' + userId
                    });
                }
            }
        });

        server.route({
            method: 'GET',
            path: '/user/stats',
            config: {
                handler: (request, reply) => {
                    reply({
                        usersOnline: this.stats.usersOnline,
                        statsNamespace: '/stats',
                        events: [this.USER_ONLINE_EVENT, this.USER_OFFLINE_EVENT]
                    })
                }
            }
        });
    }

    createNameSpace(namespace:string) {
        if (this.namespaces[namespace]) {
            return;
        }
        var nsp = this.io.of('/' + namespace);
        nsp.on('connection', socket => {
            if (this.namespaces[namespace]) {
                return;
            }
            this.userChange(namespace, true);
            this.namespaces[namespace] = socket;

            socket.on('disconnect', () => {
                this.userChange(namespace, false);
                console.log('user', namespace, 'has left');
                nsp.removeAllListeners('connection');
                delete this.namespaces[namespace];
            });

            console.log('User', namespace, 'connected');
        });
    }

    emitMessage = (namespace:string, message) => {
        if (!this.namespaces[namespace]) {
            return;
        }
        message = this.transformMessage(message);
        this.namespaces[namespace].emit(this.CLIENT_EVENTS.NEW_MESSAGE, message);
    };

    emit = (namespace:string, event:string, message) => {
        message = this.transformMessage(message);
        this.io.of('/' + namespace).emit(event, message);
    };

    exportApi(server) {
        server.expose('emitMessage', this.emitMessage);

        server.expose('getClientEventsList', this.getClientEventsList);
        server.expose('emit', this.emit);
        server.expose('broadcast', this.broadcast);
    }

    getClientEventsList = () => {
        return this.CLIENT_EVENTS;
    };

    broadcast = (event:string, message) => {
        message = this.transformMessage(message);
        this.io.emit(event, message);
    };

    private transformMessage(message) {
        if (typeof message === 'string') {
            message = {message: message};
        }
        return message;
    }

    errorInit(error) {
        if (error) {
            console.log('Error: Failed to load plugin (Realtime):', error);
        }
    }
}