import {initLogging, log} from './logging'

export interface IRegister {
    (server:any, options:any, next:any): void;
    attributes?: any;
}

export default
class Realtime {
    socketio:any;
    boom:any;
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

        this.boom = require('boom');
        this.socketio = require('socket.io');
    }

    register:IRegister = (server, options, next) => {
        //server = server.select('realtime');
        server.bind(this);

        initLogging(server);

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
            path: '/users/stats',
            config: {
                handler: (request, reply) => {
                    if (!request.auth.credentials.isAdmin) {
                        return reply(this.boom.unauthorized(''))
                    }
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

            // get conversations and build up transient namespace
            this.db.getConversationsByUserId(namespace, (err, conversations) => {
                if (err) {
                    console.error('Error while creating transient namespace');
                    return;
                }
                if (!conversations.length) {
                    log('no converstions available');
                    return;
                }
                conversations.forEach((con:any) => {
                    var opponent;

                    if (con.user_1 === namespace) {
                        opponent = con.user_2;
                    } else {
                        opponent = con.user_1;
                    }

                    // save status of read/unread message
                    this.namespaces[namespace][opponent] = {
                        transient: con[namespace + '_read'],
                        persistent: con[namespace + '_read'],
                        conversation_id: con._id
                    }
                });
            });

            // when sending ack
            this.namespaces[namespace].s.on('message_ack', (data) => {
                // write
                if (this.namespaces[data.from] && this.namespaces[data.from][data.opponent]) {
                    this.namespaces[data.from][data.opponent].transient = true;
                    log('Ack for read message --> set transient flag to true and update db if needed');
                    this.updateDatabasesReadState(data.from, data.opponent, data.conversation_id);
                }

            });

            // when disconect
            socket.on('disconnect', () => {

                this.userChange(namespace, false);
                log('user' + namespace + 'has left');
                nsp.removeAllListeners('connection');
                for (var key in this.namespaces[namespace]) {
                    if (this.namespaces[namespace].hasOwnProperty(key)) {

                        // don't persist the socket
                        if (key !== 's') {
                            this.updateDatabasesReadState(namespace, key, this.namespaces[namespace][key].conversation_id);
                        }
                    }
                }

                delete this.namespaces[namespace];
            });

            log('User' + namespace + 'connected');
        });
    }

    emitMessage = (namespace:string, message) => {
        this.emit(namespace, this.CLIENT_EVENTS.NEW_MESSAGE, message);
    };

    emit = (namespace:string, event:string, message) => {
        if (!this.namespaces[namespace]) {
            var data = {};
            data[namespace + '_read'] = false;
            log('opp not online, update database');
            this.db.updateDocumentWithCallback(message.conversation_id, data, (err, data) => {
                if (err) {
                    log('Error updating databse', err);
                }
                log('updated', data);
            });
            return;
        }

        // send transient flag to false
        if (this.namespaces[namespace][message.from]) {
            this.namespaces[namespace][message.from].transient = false;
            log('Sending message and setting transient flag to false');
        }

        // wait 10 seconds before updating db
        setTimeout(() => {
            this.updateDatabasesReadState(message.to, message.from, message.conversation_id);
        }, 10000);

        // send message
        message = this.transformMessage(message);
        this.namespaces[namespace].s.emit(event, message);
    };

    updateDatabasesReadState(from, opponent, conversation_id) {
        if (!this.namespaces[from] || !this.namespaces[from][opponent]) {
            log('user went offline, unable to persist');
            return;
        }
        var trans = this.namespaces[from][opponent].transient;
        if (trans !== this.namespaces[from][opponent].persistent) {
            this.namespaces[from][opponent].persistent = trans;
            // write to database
            var data = {};
            data[from + '_read'] = trans;
            this.db.updateDocumentWithCallback(conversation_id, data, (err, data) => {
                if (err) {
                    console.error('Updating database failed', err)
                }
                log('database updated with value: ', trans)
            });
        } else {
            log('transient value is not different from persistent value, no need to update: value', trans)
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
            log('Error: Failed to load plugin (Realtime):', error);
        }
    }
}