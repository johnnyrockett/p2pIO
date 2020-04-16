var io = require("socket.io-client");
var core = require("./core");
var { consts } = require("../config.json");
var running = false;
var user, socket, frame;
var players, allPlayers;
var kills;
// var timeout = undefined;
var dirty = false;
var deadFrames = 0;
var requesting = -1; //Frame that we are requesting at
var frameCache = []; //Frames after our request
var allowAnimation = true;
var grid = new core.Grid(consts.GRID_COUNT, (row, col, before, after) => {
	invokeRenderer("updateGrid", [row, col, before, after]);
});

var frameBufferSize = 60*4;
var frameBuffer = new Array(frameBufferSize);
var bufferIndex = 0;

var processingFrame = false;
var ctx = undefined
var address = undefined

var lastFrameHeading = 3;

function giveContext(context, contextAddress) {
    ctx = context
    address = contextAddress
}

var mimiRequestAnimationFrame;
try {
	if (window && window.document) {
		mimiRequestAnimationFrame = window.requestAnimationFrame
		|| window.webkitRequestAnimationFrame
		|| window.mozRequestAnimationFrame
		|| window.oRequestAnimationFrame
		|| window.msRequestAnimationFrame
		|| (callback => { window.setTimeout(callback, 1000 / 30) });
	}
}
catch (e) {
	mimiRequestAnimationFrame = callback => { setTimeout(callback, 1000 / 30) };
}

//Public API
function connectGame(url, name, callback, flag) {
	if (running) return; //Prevent multiple runs
	running = true;
	user = null;
	deadFrames = 0;
	var prefixes = consts.PREFIXES.split(" ");
	var names = consts.NAMES.split(" ");
	name = name || [prefixes[Math.floor(Math.random() * prefixes.length)], names[Math.floor(Math.random() * names.length)]].join(" ");
	//Socket connection
	io.j = [];
	io.sockets = [];
	socket = io(url, {
		"forceNew": true,
		upgrade: false,
		transports: ["websocket"]
	});
	socket.on("connect", () => {
		console.info("Connected to server.");
	});
	socket.on("game", data => {
		// if (timeout != undefined) clearTimeout(timeout);
		//Initialize game
		//TODO: display data.gameid --- game id #
		frame = data.frame;
        reset();
        console.log("Reset game");
		//Load players
		data.players.forEach(p => {
			var pl = new core.Player(grid, p);
			addPlayer(pl);
		});
		user = allPlayers[data.num];
		//if (!user) throw new Error();
		setUser(user);
		//Load grid
		var gridData = new Uint8Array(data.grid);
		for (var r = 0; r < grid.size; r++) {
			for (var c = 0; c < grid.size; c++) {
				var ind = gridData[r * grid.size + c] - 1;
				grid.set(r, c, ind === -1 ? null : players[ind]);
			}
		}
		invokeRenderer("paint", []);
		frame = data.frame;
		if (requesting !== -1) {
			//Update those cache frames after we updated game
			var minFrame = requesting;
			requesting = -1;
			while (frameCache.length > frame - minFrame) processFrame(frameCache[frame - minFrame]);
			frameCache = [];
        }
        setTimeout(tick, 1000);
        // setInterval(() => {
        //     console.log("voldemort with a time bomb")
        //     tick();
        // }, 1000 / 15);
	});
	// socket.on("notifyFrame", processFrame);
	socket.on("dead", () => {
		socket.disconnect(); //In case we didn't get the disconnect call
	});
	socket.on("disconnect", () => {
		console.info("Server has disconnected. Creating new game.");
		socket.disconnect();
		if (!user) return;
        user.die();
        console.log("Dead through server disconnecting.");
		dirty = true;
		paintLoop();
		running = false;
		invokeRenderer("disconnect", []);
	});
	socket.emit("hello", {
		name: name,
		type: 0, //Free-for-all
		gameid: -1, //Requested game-id, or -1 for anyone
		god: flag
	}, (success, msg) => {
		if (success) console.info("Connected to game!");
		else {
			console.error("Unable to connect to game: " + msg);
			running = false;
		}
		if (callback) callback(success, msg);
	});
}

function changeHeading(newHeading) {
    lastFrameHeading = newHeading;
	if (!user || user.dead) return;
	if (newHeading === user.currentHeading || ((newHeading % 2 === 0) ^ (user.currentHeading % 2 === 0))) {
		//user.heading = newHeading;
		if (socket) {
			socket.emit("frame", {
				frame: frame,
				heading: newHeading
			}, (success, msg) => {
				if (!success) console.error(msg);
			});
		}
	}
}

function getUser() {
	return user;
}

function getPlayers() {
	return players.slice();
}

function getOthers() {
	var ret = [];
	for (var p of players) {
		if (p !== user) ret.push(p);
	}
	return ret;
}

function disconnect() {
	socket.disconnect();
	running = false;
}

//Private API
function addPlayer(player) {
	if (allPlayers[player.num]) return; //Already added
	allPlayers[player.num] = players[players.length] = player;
	invokeRenderer("addPlayer", [player]);
	return players.length - 1;
}

function invokeRenderer(name, args) {
	var renderer = exports.renderer;
	if (renderer && typeof renderer[name] === "function") renderer[name].apply(exports, args);
}

function reverseFrame(data) {
    // Object.keys(allPlayers).forEach(function(playerId) {
    //     if (playerId in data.playerStats) {
    //         if (playerId === 0)
    //             console.log(allPlayers[playerId].posX);
    //         allPlayers[playerId].posX = data.playerStats[playerId][0];
    //         allPlayers[playerId].posY = data.playerStats[playerId][1];
    //         allPlayers[playerId].waitLag = data.playerStats[playerId][2];
    //         allPlayers[playerId].heading = data.playerStats[playerId][3];
    //     }
    // });
    for (var i=0; i<players.length; i++) {
        var playerId = players[i].num;
        if (data.playerStats[playerId] !== undefined) {
            var stats = data.playerStats[playerId];
            players[i].reConfigure(stats[0], stats[1], stats[2], stats[3]);
        } else {
            console.log('' + playerId + ' was undefined');
        }
    }
    // console.log('reversed frame to ' + data.frame.frame);
    invokeRenderer("update", [frame]);
    dirty = true;
    mimiRequestAnimationFrame(paintLoop);
}

function processFrame(data) {
    // if (processingFrame) {
    //     console.log('Missed Frame');
    // }
    // processingFrame = true;
    // console.log(data);
	// if (timeout != undefined) clearTimeout(timeout);
	if (requesting !== -1 && requesting < data.frame) {
		frameCache.push(data);
		return;
    }
    if (data.frame - 1 > frame) {
        frameCache.push(data);
    }
	else if (data.frame - 1 < frame) {
        // if (frame - data.frame - 1 > frameBufferSize) {
        //     console.error("Frame rewrite no longer in history.");
        //     // console.error("Frames don't match up!");
        //     // socket.emit("requestFrame"); //Restore data
        //     // requesting = data.frame;
        //     // frameCache.push(data);
        //     return;
        // }
        // console.log(players[0].posX);
        // for (var i=0; i < frame - data.frame; i++) {
        //     bufferIndex--;
        //     if (bufferIndex < 0)
        //         bufferIndex += frameBufferSize;
        //     reverseFrame(frameBuffer[bufferIndex]);
        // }
        // console.log(players[0].posX);
        // frame = data.frame;
        console.log(data.frame + " given. Expecting " +frame );
        return;
    }
    var playerStats = {};
	for (var i = 0; i < players.length; i++) {
		var p = players[i];
		playerStats[p.num] = [p.posX, p.posY, p.waitLag];
    }
    if (data.moves != undefined) {
        for (var i=0; i < data.moves.length; i++) {
            var move = data.moves[i];

            if (move.num in playerStats)
                playerStats[move.num].push(move.heading);
        }
    } else {
        console.log(data);
    }
    var frameState = {
        playerStats: playerStats,
        frame: data
    };
    frameBuffer[bufferIndex] = frameState;
    bufferIndex = (bufferIndex + 1) % frameBufferSize
    frame++;
    if (frame === 99) {
        console.log(frameBuffer);
    }
	if (data.newPlayers) {
		data.newPlayers.forEach(p => {
			if (user && p.num === user.num) return;
			var pl = new core.Player(grid, p);
			addPlayer(pl);
			core.initPlayer(grid, pl);
		});
	}
	var found = new Array(players.length);
	data.moves.forEach((val, i) => {
        // console.log(val);
		var player = allPlayers[val.num];
		if (!player) return;
		if (val.left) {
            player.die();
            console.log("Dead through leaving game")
        }
		found[i] = true;
		player.heading = val.heading;
	});
	for (var i = 0; i < players.length; i++) {
		//Implicitly leaving game
		if (!found[i]) {
			var player = players[i];
            player && player.die();
            console.log("Dead through implicitly leaving game")
		}
	}
	update();
	// var locs = {};
	// for (var i = 0; i < players.length; i++) {
	// 	var p = players[i];
	// 	locs[p.num] = [p.posX, p.posY, p.waitLag];
	// }
	dirty = true;
	mimiRequestAnimationFrame(paintLoop);
	// timeout = setTimeout(() => {
	// 	console.warn("Server has timed-out. Disconnecting.");
	// 	socket.disconnect();
    // }, 3000);
    // processingFrame = false;
}

function paintLoop() {
	if (!dirty) return;
	invokeRenderer("paint", []);
	dirty = false;
	if (user && user.dead) {
		// if (timeout) clearTimeout(timeout);
		if (deadFrames === 60) { //One second of frame
			var before = allowAnimation;
			allowAnimation = false;
			update();
			invokeRenderer("paint", []);
			allowAnimation = before;
			user = null;
			deadFrames = 0;
			return;
		}
		socket.disconnect();
		deadFrames++;
		dirty = true;
		update();
		mimiRequestAnimationFrame(paintLoop);
	}
}

function reset() {
	user = null;
	grid.reset();
	players = [];
	allPlayers = [];
	kills = 0;
	invokeRenderer("reset");
}

function setUser(player) {
	user = player;
	invokeRenderer("setUser", [player]);
}

function update() {
	var dead = [];
	core.updateFrame(grid, players, dead, (killer, other) => { //addKill
		if (players[killer] === user && killer !== other) kills++;
	});
	dead.forEach(val => {
		console.log((val.name || "Unnamed") + " is dead");
		delete allPlayers[val.num];
		invokeRenderer("removePlayer", [val]);
	});
	invokeRenderer("update", [frame]);
}

async function tick() {


    // Get new info
    let player_location = await ctx.get_player(address); //half way between min and max of u32
    let heading = player_location.heading();
    console.log("heading: " + heading);
    // if (newHeading === user.currentHeading || ((newHeading % 2 === 0) ^ (user.currentHeading % 2 === 0))) {
    if (heading != lastFrameHeading) {
        console.log("Uploading heading: " + lastFrameHeading)
        await ctx.apply_input(lastFrameHeading);
    }

    processFrame({
        "frame": frame+1,
        "moves": [
            {
                "num": 0,
                "left": false,
                "heading": heading
            }
        ]
    });
    frame++;
    setTimeout(tick, 0);
}

//Export stuff
[connectGame, changeHeading, getUser, getPlayers, getOthers, disconnect, giveContext].forEach(f => {
	exports[f.name] = f;
});
Object.defineProperties(exports, {
	allowAnimation: {
		get: function() {
			return allowAnimation;
		},
		set: function(val) {
			allowAnimation = !!val;
		},
		enumerable: true
	},
	grid: {
		get: function() {
			return grid;
		},
		enumerable: true
	},
	kills: {
		get: function() {
			return kills;
		},
		enumerable: true
	}
});
