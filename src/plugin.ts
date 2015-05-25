export interface IRegister {
    (server:any, options:any, next:any): void;
    attributes?: any;
}

export default
class Realtime {
    socketio:any;
    io:any;

    namespaces: [any] = [];

    CLIENT_EVENTS:any = [{
        NEW_MESSAGE: 'new_message'
    }];

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
        this.exportApi(server);
        next();
    };

    private _register(server, options) {
        server.route({
            method: 'GET',
            path: '/connect/me',
            config: {
                handler: (request, reply) => {
                    var userId:string = request.auth.credentials._id;
                    this.createNameSpace(userId);
                    reply({message: 'namespace created: ' + userId});
                    this.emitMessage(userId, 'welcome');
                }
            }
        });
    }

    createNameSpace(namespace:string) {
        var nsp = this.io.of('/' + namespace);
        nsp.on('connection', socket => {
            this.namespaces[namespace] = socket;

            console.log('User', namespace, 'connected');
        });
    }

    emitMessage = (namespace:string, message) => {
        message = this.transformMessage(message);
        this.io.of('/' + namespace).emit(this.CLIENT_EVENTS.NEW_MESSAGE, message);
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

    broadcast = (event: string, message) => {
        message = this.transformMessage(message);
        this.io.emit(event, message);
    };

    private transformMessage(message) {
        if(typeof message === 'string') {
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