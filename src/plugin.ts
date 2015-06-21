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

    db:any;

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

        server.dependency(['ark-database'], (server, continueRegister) => {

            this.db = server.plugins['ark-database'];

            this._register(server, options);
            this.exportApi(server);
            this.io = this.socketio(server.listener);
            this.createStatsNamespace();
            continueRegister();
            next();
        });


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
            this.namespaces[namespace] = {};
            this.namespaces[namespace].s = socket;

            this.namespaces[namespace].s.on('message_ack', (data) => {
                // write

                if (this.namespaces[namespace] && this.namespaces[namespace][data.opponent]) {
                    this.namespaces[namespace][data.opponent].transient = true;
                    this.updateDatabasesReadState(data.opponent, namespace, data.conversation_id);
                }
                console.log('this.namespaces[' + namespace + '][' + data.opponent+ '].transient = ', true);
            });

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
        this.emit(namespace, this.CLIENT_EVENTS.NEW_MESSAGE, message);
    };

    emit = (namespace:string, event:string, message) => {
        if (!this.namespaces[namespace]) {
            var data = {};
            data[namespace + '_read'] = false;
            this.db.updateDocumentWithCallback(message.conversation_id, data, (err, data) => {
                console.log('opp not online', err, data);
            });
            return;
        }
        this.namespaces[namespace][message.from] = {
            transient: false
        };
        setTimeout(() => {
            this.updateDatabasesReadState(message.from, message.to, message.conversation_id);
        }, 10000);
        console.log('this.namespaces[' + namespace + '][' + message.from + '].transient = ', false);
        message = this.transformMessage(message);
        this.namespaces[namespace].s.emit(event, message);
    };

    updateDatabasesReadState(from, to, conversation_id) {
        var trans = this.namespaces[to][from].transient;
        console.log('updateDatabasesReadState compare trans !== pers', trans, this.namespaces[to][from].persistent)
        if(trans !== this.namespaces[to][from].persistent) {
            this.namespaces[to][from].persistent = trans;
            console.log('persistent to from' , to, from, this.namespaces[to][from].persistent )
            // write to database
            var data = {};
            data[to + '_read'] = trans;
            this.db.updateDocumentWithCallback(conversation_id, data, (err, data) => {
                console.log(err, data);
            });
        }
    }

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