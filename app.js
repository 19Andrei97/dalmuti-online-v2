var express = require("express");
var app = express();
var http = require("http").Server(app);
var io = require("socket.io")(http);
var cors = require("cors");
let {
  Player,
  game_state,
  Game,
  user_count,
  connectNumber,
  roomsInfo,
} = require("./server/config");

var port = process.env.PORT || 8080;
app.use(express.static(__dirname + "/src"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/src/index.html");
});

app.get("/help", (req, res) => {
  res.sendFile(__dirname + "/src/help.html");
});

app.get(`/room/:roomName`, cors(), (req, res, next) => {
  if (
    roomsInfo.rooms.open[req.params.roomName] ||
    roomsInfo.rooms.hide[req.params.roomName]
  ) {
    res.sendFile(__dirname + "/src/room.html");
  } else next();
});

// catch 404 and forward to error handler
app.use((req, res, next) => {
  var err = new Error("Not Found");
  err.status = 404;
  return next(err);
});
// development error handler
if (app.get("env") === "development") {
  app.use((err, req, res, next) => {
    res.status(err.status || 500);
    console.log({
      message: err.message,
      // error: err,
    });
    return res.sendFile(__dirname + "/src/fourOfour.html");
  });
}

io.on("connection", (socket) => {
  user_count++;
  socket.userData = new Player("Guest" + connectNumber, "main room");
  connectNumber++;

  // give update to a client only
  socket.join("waiting room");

  io.to("waiting room").emit(
    "refresh waiting room",
    socket.userData,
    roomsInfo.rooms.open,
    user_count
  );

  console.log(
    "\x1b[36mNEW:\x1b[0m",
    socket.userData.nickname + " joined main room"
  );

  //! PLAYER SETTINGS

  socket.on("init", () => {
    socket.emit("update sender", socket.userData);
  });

  // Set nickname and check adding to room
  socket.on("set new nickname", (n_nickname, roomId) => {
    console.log(
      "\x1b[32mUPDATE:\x1b[0m",
      "Nickname change from " + socket.userData.nickname + " to " + n_nickname
    );
    socket.userData.nickname = n_nickname;

    // Check if player should be assosiacted to a room
    if (
      roomsInfo.rooms.open.hasOwnProperty(roomId) ||
      roomsInfo.rooms.hide.hasOwnProperty(roomId)
    ) {
      joinRoom(socket, roomsInfo.rooms, roomId);
    }

    socket.emit("update sender", socket.userData);
  });

  //! ROOMS FUNCTIONS

  // CREATE ROOM
  socket.on("create game room", (room_name, hide) => {
    roomsInfo.roomNumber++;
    let idRoom = `${roomsInfo.roomNumber}-${room_name}`;
    joinRoom(socket, roomsInfo.rooms, idRoom, hide); // Use helper to create and join room
    socket.emit("connectUrl", `/room/${idRoom}`);
  });

  // JOIN ROOM
  socket.on("join game room", (roomId) => {
    if (
      roomsInfo.rooms.open.hasOwnProperty(roomId) ||
      roomsInfo.rooms.hide.hasOwnProperty(roomId)
    ) {
      joinRoom(socket, roomsInfo.rooms, roomId);
      socket.emit("connectUrl", `/room/${roomId}`);
    } else {
      socket.emit("alert", "language.noRoom");
      io.to("waiting room").emit(
        "refresh waiting room",
        socket.userData,
        roomsInfo.rooms.open,
        user_count
      );
      return;
    }
  });

  // SHOW MESSAGE
  socket.on("chat message", (msg) => {
    if (msg !== "") {
      io.to(socket.userData.cur_room).emit(
        "chat message",
        socket.userData.nickname,
        msg
      );
    }
  });

  // CHECK USER READY
  socket.on("ready", () => {
    let room_name = socket.userData.cur_room;

    if (roomsInfo.rooms.open.hasOwnProperty(room_name)) {
      if (socket.userData.ready === true) {
        socket.userData.ready = false;
        roomsInfo.rooms.open[room_name].game.readyCount--;
        syncUserToRoom(socket, roomsInfo.rooms.open);

        io.to(room_name).emit(
          "refresh game room",
          roomsInfo.rooms.open[room_name]
        );
        return;
      }

      // Ready only on Waiting room
      if (
        roomsInfo.rooms.open[room_name].game.state == game_state.WAITING &&
        !socket.userData.ready
      ) {
        socket.userData.ready = true;
        roomsInfo.rooms.open[room_name].game.readyCount++;
        syncUserToRoom(socket, roomsInfo.rooms.open);

        // send out updated data
        io.to(room_name).emit(
          "refresh game room",
          roomsInfo.rooms.open[room_name]
        );

        // CHECK TO START GAME
        // Shared data, so use roomData not userData
        if (
          Object.keys(roomsInfo.rooms.open[room_name].sockets).length >= 2 &&
          roomsInfo.rooms.open[room_name].game.readyCount ==
            Object.keys(roomsInfo.rooms.open[room_name].sockets).length
        ) {
          //start game
          console.log("\x1b[36mNEW:\x1b[0m", room_name + ": game started");
          io.to(room_name).emit("chat announce", "language.started", "blue");

          // set order, shuffle, etc.
          roomsInfo.rooms.open[room_name].game.start(
            roomsInfo.rooms.open[room_name]
          );

          // distribute
          let handlim = Math.floor(
            80 / Object.keys(roomsInfo.rooms.open[room_name].sockets).length
          );
          let cnt = 0;
          for (const [sid, user] of Object.entries(
            roomsInfo.rooms.open[room_name].sockets
          )) {
            for (let i = cnt * handlim; i < handlim * cnt + handlim; i++) {
              user.hand.push(roomsInfo.rooms.open[room_name].game.deck[i]); // userData and room user Data not in sync
              user.pointsReceived = false; // Reset points condition
            }
            cnt++;
          }

          // SWAP CARDS TAXS
          if (roomsInfo.rooms.open[room_name].leaderBoard) {
            let leaderB = roomsInfo.rooms.open[room_name].leaderBoard;
            if (
              leaderB[0][3] === "greaterDalmuti" &&
              leaderB[leaderB.length - 1][3] === "greaterPeon"
            ) {
              // SORT FIRST
              roomsInfo.rooms.open[room_name].sockets[leaderB[0][2]].hand.sort(
                function (a, b) {
                  return a - b;
                }
              );
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.sort(function (a, b) {
                return a - b;
              });

              // TAKE CARTS
              let lastTwo =
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[0][2]
                ].hand.splice(-2);
              let isJolly = lastTwo.findIndex((val) => {
                return val === 13;
              });
              if (isJolly !== -1) {
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[0][2]
                ].hand.unshift(lastTwo.splice(isJolly, 1));
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[0][2]
                ].hand.push(lastTwo[0]);
                lastTwo =
                  roomsInfo.rooms.open[room_name].sockets[
                    leaderB[0][2]
                  ].hand.splice(-2);
              }
              isJolly = lastTwo.findIndex((val) => {
                return val === 13;
              });
              if (isJolly !== -1) {
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[0][2]
                ].hand.unshift(lastTwo.splice(isJolly, 1));
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[0][2]
                ].hand.push(lastTwo[0]);
                lastTwo =
                  roomsInfo.rooms.open[room_name].sockets[
                    leaderB[0][2]
                  ].hand.splice(-2);
              }
              let firstTwo = roomsInfo.rooms.open[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.splice(0, 2);
              console.log(lastTwo, firstTwo);

              // SWAP CARDS
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.push(lastTwo[1]);
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.push(lastTwo[0]);
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[0][2]
              ].hand.unshift(firstTwo[1]);
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[0][2]
              ].hand.unshift(firstTwo[0]);

              // MESSAGE TO EVERYONE
              io.to(room_name).emit(
                "chat announce",
                "language.swap",
                "blue",
                roomsInfo.rooms.open[room_name].sockets[leaderB[0][2]].nickname,
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[leaderB.length - 1][2]
                ].nickname
              );

              // MESSAGE TO USERS
              io.to(leaderB[0][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "green",
                `${lastTwo[0]} & ${lastTwo[1]}`,
                `${firstTwo[0]} & ${firstTwo[1]}`
              );

              io.to(leaderB[leaderB.length - 1][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "red",
                `${firstTwo[0]} & ${firstTwo[1]}`,
                `${lastTwo[0]} & ${lastTwo[1]}`
              );
            }
            if (
              leaderB[1][3] === "lesserDalmuti" &&
              leaderB[leaderB.length - 2][3] === "lesserPeon"
            ) {
              // SORT FIRST
              roomsInfo.rooms.open[room_name].sockets[leaderB[1][2]].hand.sort(
                function (a, b) {
                  return a - b;
                }
              );
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.sort(function (a, b) {
                return a - b;
              });

              // TAKE CARTS
              let lastOne =
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[1][2]
                ].hand.splice(-1);
              let isJolly = lastOne.findIndex((val) => {
                return val === 13;
              });
              if (isJolly !== -1) {
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[1][2]
                ].hand.unshift(lastOne.splice(isJolly, 1));
                lastOne =
                  roomsInfo.rooms.open[room_name].sockets[
                    leaderB[1][2]
                  ].hand.splice(-1);
              }
              let firstOne = roomsInfo.rooms.open[room_name].sockets[
                leaderB[leaderB.length - 2][2]
              ].hand.splice(0, 1);
              console.log(lastOne, firstOne);

              // SWAP CARDS
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[leaderB.length - 2][2]
              ].hand.push(lastOne[0]);
              roomsInfo.rooms.open[room_name].sockets[
                leaderB[1][2]
              ].hand.unshift(firstOne[0]);

              // MESSAGE TO EVERYONE
              io.to(room_name).emit(
                "chat announce",
                "language.swap",
                "blue",
                roomsInfo.rooms.open[room_name].sockets[leaderB[1][2]].nickname,
                roomsInfo.rooms.open[room_name].sockets[
                  leaderB[leaderB.length - 2][2]
                ].nickname
              );

              // MESSAGE TO USERS
              io.to(leaderB[1][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "green",
                `${lastOne[0]}`,
                `${firstOne[0]}`
              );

              io.to(leaderB[leaderB.length - 2][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "red",
                `${firstOne[0]}`,
                `${lastOne[0]}`
              );
            }
          }

          io.to("waiting room").emit(
            "refresh waiting room",
            socket.userData,
            roomsInfo.rooms.open,
            user_count
          ); // notify start to main room

          io.to(room_name).emit(
            "refresh game room",
            roomsInfo.rooms.open[room_name]
          );
        }
      }
    } else if (roomsInfo.rooms.hide.hasOwnProperty(room_name)) {
      if (socket.userData.ready === true) {
        socket.userData.ready = false;
        roomsInfo.rooms.hide[room_name].game.readyCount--;
        syncUserToRoom(socket, roomsInfo.rooms.hide);

        io.to(room_name).emit(
          "refresh game room",
          roomsInfo.rooms.hide[room_name]
        );
        return;
      }

      // Ready only on Waiting room
      if (
        roomsInfo.rooms.hide[room_name].game.state == game_state.WAITING &&
        !socket.userData.ready
      ) {
        socket.userData.ready = true;
        roomsInfo.rooms.hide[room_name].game.readyCount++;
        syncUserToRoom(socket, roomsInfo.rooms.hide);

        // send out updated data
        io.to(room_name).emit(
          "refresh game room",
          roomsInfo.rooms.hide[room_name]
        );

        // CHECK TO START GAME
        // Shared data, so use roomData not userData
        if (
          Object.keys(roomsInfo.rooms.hide[room_name].sockets).length >= 2 &&
          roomsInfo.rooms.hide[room_name].game.readyCount ==
            Object.keys(roomsInfo.rooms.hide[room_name].sockets).length
        ) {
          //start game
          console.log("\x1b[36mNEW:\x1b[0m", room_name + ": game started");
          io.to(room_name).emit("chat announce", "language.started", "blue");

          // set order, shuffle, etc.
          roomsInfo.rooms.hide[room_name].game.start(
            roomsInfo.rooms.hide[room_name]
          );

          // distribute
          let handlim = Math.floor(
            80 / Object.keys(roomsInfo.rooms.hide[room_name].sockets).length
          );
          let cnt = 0;
          for (const [sid, user] of Object.entries(
            roomsInfo.rooms.hide[room_name].sockets
          )) {
            for (let i = cnt * handlim; i < handlim * cnt + handlim; i++) {
              user.hand.push(roomsInfo.rooms.hide[room_name].game.deck[i]); // userData and room user Data not in sync
              user.pointsReceived = false; // Reset points condition
            }
            cnt++;
          }

          // SWAP CARDS TAXS
          if (roomsInfo.rooms.hide[room_name].leaderBoard) {
            let leaderB = roomsInfo.rooms.hide[room_name].leaderBoard;
            if (
              leaderB[0][3] === "greaterDalmuti" &&
              leaderB[leaderB.length - 1][3] === "greaterPeon"
            ) {
              // SORT FIRST
              roomsInfo.rooms.hide[room_name].sockets[leaderB[0][2]].hand.sort(
                function (a, b) {
                  return a - b;
                }
              );
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.sort(function (a, b) {
                return a - b;
              });

              // TAKE CARTS
              let lastTwo =
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[0][2]
                ].hand.splice(-2);
              let isJolly = lastTwo.findIndex((val) => {
                return val === 13;
              });
              if (isJolly !== -1) {
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[0][2]
                ].hand.unshift(lastTwo.splice(isJolly, 1));
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[0][2]
                ].hand.push(lastTwo[0]);
                lastTwo =
                  roomsInfo.rooms.hide[room_name].sockets[
                    leaderB[0][2]
                  ].hand.splice(-2);
              }
              isJolly = lastTwo.findIndex((val) => {
                return val === 13;
              });
              if (isJolly !== -1) {
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[0][2]
                ].hand.unshift(lastTwo.splice(isJolly, 1));
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[0][2]
                ].hand.push(lastTwo[0]);
                lastTwo =
                  roomsInfo.rooms.hide[room_name].sockets[
                    leaderB[0][2]
                  ].hand.splice(-2);
              }
              let firstTwo = roomsInfo.rooms.hide[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.splice(0, 2);
              console.log(lastTwo, firstTwo);

              // SWAP CARDS
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.push(lastTwo[1]);
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.push(lastTwo[0]);
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[0][2]
              ].hand.unshift(firstTwo[1]);
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[0][2]
              ].hand.unshift(firstTwo[0]);

              // MESSAGE TO EVERYONE
              io.to(room_name).emit(
                "chat announce",
                "language.swap",
                "blue",
                roomsInfo.rooms.hide[room_name].sockets[leaderB[0][2]].nickname,
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[leaderB.length - 1][2]
                ].nickname
              );

              // MESSAGE TO USERS
              io.to(leaderB[0][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "green",
                `${lastTwo[0]} & ${lastTwo[1]}`,
                `${firstTwo[0]} & ${firstTwo[1]}`
              );

              io.to(leaderB[leaderB.length - 1][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "red",
                `${firstTwo[0]} & ${firstTwo[1]}`,
                `${lastTwo[0]} & ${lastTwo[1]}`
              );
            }
            if (
              leaderB[1][3] === "lesserDalmuti" &&
              leaderB[leaderB.length - 2][3] === "lesserPeon"
            ) {
              // SORT FIRST
              roomsInfo.rooms.hide[room_name].sockets[leaderB[1][2]].hand.sort(
                function (a, b) {
                  return a - b;
                }
              );
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[leaderB.length - 1][2]
              ].hand.sort(function (a, b) {
                return a - b;
              });

              // TAKE CARTS
              let lastOne =
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[1][2]
                ].hand.splice(-1);
              let isJolly = lastOne.findIndex((val) => {
                return val === 13;
              });
              if (isJolly !== -1) {
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[1][2]
                ].hand.unshift(lastOne.splice(isJolly, 1));
                lastOne =
                  roomsInfo.rooms.hide[room_name].sockets[
                    leaderB[1][2]
                  ].hand.splice(-1);
              }
              let firstOne = roomsInfo.rooms.hide[room_name].sockets[
                leaderB[leaderB.length - 2][2]
              ].hand.splice(0, 1);
              console.log(lastOne, firstOne);

              // SWAP CARDS
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[leaderB.length - 2][2]
              ].hand.push(lastOne[0]);
              roomsInfo.rooms.hide[room_name].sockets[
                leaderB[1][2]
              ].hand.unshift(firstOne[0]);

              // MESSAGE TO EVERYONE
              io.to(room_name).emit(
                "chat announce",
                "language.swap",
                "blue",
                roomsInfo.rooms.hide[room_name].sockets[leaderB[1][2]].nickname,
                roomsInfo.rooms.hide[room_name].sockets[
                  leaderB[leaderB.length - 2][2]
                ].nickname
              );

              // MESSAGE TO USERS
              io.to(leaderB[1][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "green",
                `${lastOne[0]}`,
                `${firstOne[0]}`
              );

              io.to(leaderB[leaderB.length - 2][2]).emit(
                "chat announce taxs",
                "language.taxs",
                "red",
                `${firstOne[0]}`,
                `${lastOne[0]}`
              );
            }
          }

          io.to(room_name).emit(
            "refresh game room",
            roomsInfo.rooms.hide[room_name]
          );
        }
      }
    }
  });

  socket.on("play", (selected_card) => {
    let room_name = socket.userData.cur_room;

    if (roomsInfo.rooms.open.hasOwnProperty(room_name)) {
      // but first of all, is it playing?
      if (roomsInfo.rooms.open[room_name].game.state != game_state.PLAYING) {
        socket.emit("alert", "language.cheat");
        return;
      }

      if (checkOrder(socket, roomsInfo.rooms.open[room_name])) {
        // delete 0 cards, this won't happen unless someone messed with client code
        for (const [card, val] of Object.entries(selected_card)) {
          if (val == 0) delete selected_card[card];
        }

        // check PASS
        if (Object.keys(selected_card).length == 0) {
          let tmp_idx = roomsInfo.rooms.open[room_name].game.cur_order_idx;
          roomsInfo.rooms.open[room_name].game.cur_order[tmp_idx] = 0; // pass
          // if this is last pass, erase last hand give prior to last player who played
          // also renew cur_order for next round
          // and update last hand. Last hand will be used to display cards on field
          let testLastPass =
            roomsInfo.rooms.open[room_name].game.nextPlayer(selected_card);

          io.to(room_name).emit(
            "chat announce",
            "language.passed",
            "black",
            socket.userData.nickname
          );

          io.to(room_name).emit(
            "refresh game room",
            roomsInfo.rooms.open[room_name],
            testLastPass
          );
        } else if (
          checkValidity(socket, roomsInfo.rooms.open[room_name], selected_card)
        ) {
          if (checkRule(roomsInfo.rooms.open[room_name], selected_card)) {
            // Everything seems fine.

            // update hand
            updateHand(socket, roomsInfo.rooms.open[room_name], selected_card);

            //Winning condition
            if (
              roomsInfo.rooms.open[room_name].sockets[socket.id].hand.length ==
              0
            ) {
              // win due to empty hand
              roomsInfo.rooms.open[room_name].game.updateOrder(
                socket.userData.seat,
                room_name
              );

              // POINTS COUNTER
              let obj = roomsInfo.rooms.open[room_name].sockets;
              let leaderBoard = [];
              for (const player in obj) {
                if (
                  obj[player].hand.length === 0 &&
                  !obj[player].pointsReceived &&
                  obj[player].ready
                ) {
                  if (!obj[player].points) {
                    let points = 0;
                    roomsInfo.rooms.open[room_name].game.order.forEach(
                      (val) => {
                        if (val === true) points++;
                      }
                    );
                    obj[player].points = points;
                    obj[player].pointsReceived = true;
                    leaderBoard.push([
                      obj[player].points,
                      obj[player].nickname,
                      player,
                    ]);
                  } else {
                    let points = 0;
                    roomsInfo.rooms.open[room_name].game.order.forEach(
                      (val) => {
                        if (val === true) points++;
                      }
                    );
                    obj[player].points += points;
                    obj[player].pointsReceived = true;
                    leaderBoard.push([
                      obj[player].points,
                      obj[player].nickname,
                      player,
                    ]);
                  }
                } else if (
                  (obj[player].hand.length > 0 &&
                    !obj[player].pointsReceived &&
                    !obj[player].points) ||
                  !obj[player].ready
                ) {
                  leaderBoard.push([0, obj[player].nickname, player]);
                } else {
                  leaderBoard.push([
                    obj[player].points,
                    obj[player].nickname,
                    player,
                  ]);
                }
              }
              leaderBoard.sort((a, b) => b[0] - a[0]); // For descending sort

              if (leaderBoard.length === 3) {
                leaderBoard[0].push("greaterDalmuti");
                leaderBoard[1].push("merchant");
                leaderBoard[2].push("greaterPeon");
              } else if (leaderBoard.length > 3 && leaderBoard.length <= 8) {
                leaderBoard.forEach((val, i) => {
                  if (i === 0) val.push("greaterDalmuti");
                  else if (i === 1) val.push("lesserDalmuti");
                  else if (leaderBoard.length - i === 1) val.push("lesserPeon");
                  else if (leaderBoard.length - i === 0)
                    val.push("greaterPeon");
                  else val.push("merchant");
                });
              } else {
                leaderBoard[0].push("greaterDalmuti");
              }

              roomsInfo.rooms.open[room_name].leaderBoard = leaderBoard;

              io.to(room_name).emit(
                "chat announce",
                "language.finished",
                "green",
                socket.userData.nickname
              );

              if (roomsInfo.rooms.open[room_name].game.isOneLeft()) {
                io.to(room_name).emit("chat announce", "language.ended", "red");
                //end game
                roomsInfo.rooms.open[room_name].game.end();
                for (const [sid, userData] of Object.entries(
                  roomsInfo.rooms.open[room_name].sockets
                )) {
                  userData.reset();
                }
              }
            }

            roomsInfo.rooms.open[room_name].game.nextPlayer(selected_card);
            // refresh
            io.to(room_name).emit(
              "refresh game room",
              roomsInfo.rooms.open[room_name],
              true,
              socket.userData
            );
          } else {
            // nope
            socket.emit("alert", "language.wrongCard");
          }
        } else {
          socket.emit("connectUrl", "/");
          socket.emit("alert", "language.roomFull");
        }
      } // check order
      else {
        socket.emit("alert", "language.waitTurn");
      }
    } else if (roomsInfo.rooms.hide.hasOwnProperty(room_name)) {
      // but first of all, is it playing?
      if (roomsInfo.rooms.hide[room_name].game.state != game_state.PLAYING) {
        socket.emit("alert", "language.cheat");
        return;
      }

      if (checkOrder(socket, roomsInfo.rooms.hide[room_name])) {
        // delete 0 cards, this won't happen unless someone messed with client code
        for (const [card, val] of Object.entries(selected_card)) {
          if (val == 0) delete selected_card[card];
        }

        // check PASS
        if (Object.keys(selected_card).length == 0) {
          let tmp_idx = roomsInfo.rooms.hide[room_name].game.cur_order_idx;
          roomsInfo.rooms.hide[room_name].game.cur_order[tmp_idx] = 0; // pass
          // if this is last pass, erase last hand give prior to last player who played
          // also renew cur_order for next round
          // and update last hand. Last hand will be used to display cards on field
          let testLastPass =
            roomsInfo.rooms.hide[room_name].game.nextPlayer(selected_card);

          io.to(room_name).emit(
            "chat announce",
            `language.passed`,
            "black",
            socket.userData.nickname
          );

          io.to(room_name).emit(
            "refresh game room",
            roomsInfo.rooms.hide[room_name],
            testLastPass
          );
        } else if (
          checkValidity(socket, roomsInfo.rooms.hide[room_name], selected_card)
        ) {
          if (checkRule(roomsInfo.rooms.hide[room_name], selected_card)) {
            // Everything seems fine.

            // update hand
            updateHand(socket, roomsInfo.rooms.hide[room_name], selected_card);

            //Winning condition
            if (
              roomsInfo.rooms.hide[room_name].sockets[socket.id].hand.length ==
              0
            ) {
              // win due to empty hand
              roomsInfo.rooms.hide[room_name].game.updateOrder(
                socket.userData.seat,
                room_name
              );

              // POINTS COUNTER
              let obj = roomsInfo.rooms.hide[room_name].sockets;
              let leaderBoard = [];
              for (const player in obj) {
                if (
                  obj[player].hand.length === 0 &&
                  !obj[player].pointsReceived &&
                  obj[player].ready
                ) {
                  if (!obj[player].points) {
                    let points = 0;
                    roomsInfo.rooms.hide[room_name].game.order.forEach(
                      (val) => {
                        if (val === true) points++;
                      }
                    );
                    obj[player].points = points;
                    obj[player].pointsReceived = true;
                    leaderBoard.push([
                      obj[player].points,
                      obj[player].nickname,
                      player,
                    ]);
                  } else {
                    let points = 0;
                    roomsInfo.rooms.hide[room_name].game.order.forEach(
                      (val) => {
                        if (val === true) points++;
                      }
                    );
                    obj[player].points += points;
                    obj[player].pointsReceived = true;
                    leaderBoard.push([
                      obj[player].points,
                      obj[player].nickname,
                      player,
                    ]);
                  }
                } else if (
                  (obj[player].hand.length > 0 &&
                    !obj[player].pointsReceived) ||
                  !obj[player].ready
                ) {
                  leaderBoard.push([0, obj[player].nickname, player]);
                } else {
                  leaderBoard.push([
                    obj[player].points,
                    obj[player].nickname,
                    player,
                  ]);
                }
              }

              leaderBoard.sort((a, b) => b[0] - a[0]); // For descending sort

              if (leaderBoard.length === 3) {
                leaderBoard[0].push("greaterDalmuti");
                leaderBoard[1].push("merchant");
                leaderBoard[2].push("greaterPeon");
              } else if (leaderBoard.length > 3 && leaderBoard.length < 8) {
                leaderBoard.forEach((val, i) => {
                  if (i === 0) val.push("greaterDalmuti");
                  else if (i === 1) val.push("lesserDalmuti");
                  else if (leaderBoard.length - i === 1) val.push("lesserPeon");
                  else if (leaderBoard.length - i === 0)
                    val.push("greaterPeon");
                  else val.push("merchant");
                });
              } else {
                leaderBoard[0].push("greaterDalmuti");
              }

              roomsInfo.rooms.hide[room_name].leaderBoard = leaderBoard;

              io.to(room_name).emit(
                "chat announce",
                "language.finished",
                "green",
                socket.userData.nickname
              );

              if (roomsInfo.rooms.hide[room_name].game.isOneLeft()) {
                io.to(room_name).emit("chat announce", "language.ended", "red");
                // End game
                roomsInfo.rooms.hide[room_name].game.end();
                for (const [sid, userData] of Object.entries(
                  roomsInfo.rooms.hide[room_name].sockets
                )) {
                  userData.reset();
                }
              }
            }

            roomsInfo.rooms.hide[room_name].game.nextPlayer(selected_card);
            // refresh
            io.to(room_name).emit(
              "refresh game room",
              roomsInfo.rooms.hide[room_name],
              true,
              socket.userData
            );
          } else {
            // nope
            socket.emit("alert", "language.wrongCard");
          }
        } else {
          socket.emit("alert", "language.cheat");
        }
      } // check order
      else {
        socket.emit("alert", "language.waitTurn");
      }
    }
  });

  socket.on("disconnect", () => {
    user_count--;
    console.log(
      "\x1b[31mDISCONNECTED:\x1b[0m",
      socket.userData.nickname + " disconnected from server"
    );

    if (roomsInfo.rooms.open.hasOwnProperty(socket.userData.cur_room)) {
      updateRoomDisconnect(
        socket,
        socket.userData.cur_room,
        roomsInfo.rooms.open
      );

      io.to("waiting room").emit(
        "refresh waiting room",
        socket.userData,
        roomsInfo.rooms.open,
        user_count
      );
    } else if (roomsInfo.rooms.hide.hasOwnProperty(socket.userData.cur_room)) {
      updateRoomDisconnect(
        socket,
        socket.userData.cur_room,
        roomsInfo.rooms.hide
      );
    }
  });
  //Game, broadcast only to same room
});

//! HELPER

// ADD USER TO ROOM IN SERVER
function syncUserToRoom(socket, roomObj) {
  // Check if user isn't in waiting rooom and already in the room
  if (
    socket.userData.cur_room != "waiting room" &&
    roomObj[socket.userData.cur_room]
  ) {
    if (!roomObj[socket.userData.cur_room].sockets) {
      roomObj[socket.userData.cur_room].sockets = {};
      roomObj[socket.userData.cur_room].sockets[socket.id] = socket.userData;
    } else {
      roomObj[socket.userData.cur_room].sockets[socket.id] = socket.userData;
    }
  }
  // Add user to room in server
}

// DISCONNECT
function updateRoomDisconnect(socket, room_name, roomsObj) {
  socket.leave(room_name);
  socket.join("waiting room");

  // update room
  if (roomsObj[room_name]) {
    roomsObj[room_name].seats[socket.userData.seat] = false;
    delete roomsObj[room_name].sockets[socket.id]; // Delete player from room

    // undo ready if left with 'ready' before the game start
    if (socket.userData.ready) roomsObj[room_name].game.readyCount--;

    // user left during the game
    // omit from order list
    if (roomsObj[room_name].game.state == game_state.PLAYING) {
      roomsObj[room_name].game.updateOrder(socket.userData.seat, room_name);

      if (roomsObj[room_name].game.isOneLeft()) {
        io.to(room_name).emit("chat announce", "language.ended", "red");
        //end game
        roomsObj[room_name].game.end();
        for (const [sid, userData] of Object.entries(
          roomsObj[room_name].sockets
        )) {
          userData.reset();
        }
      }

      // pass or evaluate or refresh during game...? pass turn?
      if (roomsObj[room_name].game.cur_order_idx == socket.userData.seat) {
        // pass turn
        roomsObj[room_name].game.nextPlayer({});
      }
      io.to(room_name).emit("refresh game room", roomsObj[room_name]);
    }

    // Loop delete empty room exepct this
    for (const key in roomsObj) {
      if (Object.keys(roomsObj[key].sockets).length <= 0 && key !== room_name) {
        delete roomsObj[key];
      }
    }
  }

  // update/reset user
  socket.userData.reset();
  socket.userData.leaveRoom();

  io.to(room_name).emit("refresh game room", roomsObj[room_name]);
  io.to(room_name).emit("chat connection", socket.userData);
}

// JOIN THE ROOM
function joinRoom(socket, roomObj, room_name, hide) {
  // seat vacancy check
  socket.leave("waiting room");
  socket.join(room_name);
  console.log(socket.userData.nickname + " joined " + room_name);

  if (roomsInfo.rooms.open.hasOwnProperty(room_name)) {
    // Loop for free seats
    for (let i = 0; i < 8; i++) {
      if (!roomObj.open[room_name].seats[i]) {
        // is vacant
        roomObj.open[room_name].seats[i] = true;
        socket.userData.seat = i;
        break;
      }
    }

    // Check if room is full
    if (socket.userData.seat == -1) {
      //TODO full emit
      console.log("Room " + room_name + " is full");
      socket.leave(room_name);
      socket.join("waiting room");
      socket.emit(
        "refresh waiting room",
        socket.userData,
        roomsInfo.rooms.open,
        user_count
      );
      socket.emit("connectUrl", "/");
      socket.emit("alert", "language.roomFull");
      return false;
    }

    // if there is no game object, give one
    if (!roomObj.open[room_name].game)
      roomObj.open[room_name].game = new Game();

    //update user
    socket.userData.cur_room = room_name;

    //update room data
    syncUserToRoom(socket, roomObj.open);

    //refresh list
    io.to("waiting room").emit(
      "refresh waiting room",
      socket.userData,
      roomsInfo.rooms.open,
      user_count
    );

    io.to(room_name).emit("refresh game room", roomsInfo.rooms.open[room_name]); // send info about room
    io.to(room_name).emit("chat connection", socket.userData);

    socket.emit("update sender", socket.userData);
  } else if (roomsInfo.rooms.hide.hasOwnProperty(room_name)) {
    // Loop for free seats
    for (let i = 0; i < 8; i++) {
      if (!roomObj.hide[room_name].seats[i]) {
        // is vacant
        roomObj.hide[room_name].seats[i] = true;
        socket.userData.seat = i;
        break;
      }
    }

    // Check if room is full
    if (socket.userData.seat == -1) {
      //TODO full emit
      console.log("room full");
      socket.leave(room_name);
      socket.join("waiting room");
      socket.emit("connectUrl", "/");
      socket.emit("alert", "language.roomFull");
      return false;
    }

    // if there is no game object, give one
    if (!roomObj.hide[room_name].game)
      roomObj.hide[room_name].game = new Game();

    //update user
    socket.userData.cur_room = room_name;

    //update room data
    syncUserToRoom(socket, roomObj.hide);

    //refresh list
    io.to(room_name).emit("refresh game room", roomsInfo.rooms.hide[room_name]); // send info about room

    io.to(room_name).emit("chat connection", socket.userData);

    socket.emit("update sender", socket.userData);
  } else if (hide) {
    if (!roomObj.hide[room_name] || !roomObj.hide[room_name].seats) {
      roomObj.hide[room_name] = {};
      roomObj.hide[room_name].seats = new Array(8).fill(false);
    }

    // Loop for free seats
    for (let i = 0; i < 8; i++) {
      if (!roomObj.hide[room_name].seats[i]) {
        // is vacant
        roomObj.hide[room_name].seats[i] = true;
        socket.userData.seat = i;
        break;
      }
    }

    // Check if room is full
    if (socket.userData.seat == -1) {
      //TODO full emit
      console.log("room full");
      socket.leave(room_name);
      socket.join("waiting room");

      socket.emit("connectUrl", "/");
      socket.emit("alert", "language.roomFull");
      return false;
    }

    // if there is no game object, give one
    if (!roomObj.hide[room_name].game)
      roomObj.hide[room_name].game = new Game();

    //update user
    socket.userData.cur_room = room_name;

    //update room data
    syncUserToRoom(socket, roomObj.hide);

    //refresh list
    io.to(room_name).emit("refresh game room", roomsInfo.rooms.hide[room_name]); // send info about room

    io.to(room_name).emit("chat connection", socket.userData);

    socket.emit("update sender", socket.userData);
  } else {
    if (!roomObj.open[room_name] || !roomObj.open[room_name].seats) {
      roomObj.open[room_name] = {};
      roomObj.open[room_name].seats = new Array(8).fill(false);
    }

    // Loop for free seats
    for (let i = 0; i < 8; i++) {
      if (!roomObj.open[room_name].seats[i]) {
        // is vacant
        roomObj.open[room_name].seats[i] = true;
        socket.userData.seat = i;
        break;
      }
    }

    // Check if room is full
    if (socket.userData.seat == -1) {
      //TODO full emit
      console.log("room full");
      socket.leave(room_name);
      socket.join("waiting room");
      socket.emit(
        "refresh waiting room",
        socket.userData,
        roomsInfo.rooms.open,
        user_count
      );

      socket.emit("connectUrl", "/");
      socket.emit("alert", "language.roomFull");
      return false;
    }

    // if there is no game object, give one
    if (!roomObj.open[room_name].game)
      roomObj.open[room_name].game = new Game();

    //update user
    socket.userData.cur_room = room_name;

    //update room data
    syncUserToRoom(socket, roomObj.open);

    //refresh list
    io.to("waiting room").emit(
      "refresh waiting room",
      socket.userData,
      roomsInfo.rooms.open,
      user_count
    );

    io.to(room_name).emit("refresh game room", roomsInfo.rooms.open[room_name]); // send info about room
    io.to(room_name).emit("chat connection", socket.userData);

    socket.emit("update sender", socket.userData);
  }
}

function checkOrder(socket, roomData) {
  if (socket.userData.seat != roomData.sockets[socket.id].seat)
    // correctly in the room?
    return false; // illegal behavior detected

  if (roomData.game.cur_order_idx != socket.userData.seat)
    // check turn
    return false; // illegal behavior detected

  return true;
}

// check if selected cards are actually in hand
function checkValidity(socket, roomData, selected_card) {
  let sid = socket.id;
  let hand_map = {};
  for (let i = 0; i < roomData.sockets[sid].hand.length; i++) {
    let card = roomData.sockets[sid].hand[i];
    if (!hand_map[card]) hand_map[card] = 0;
    hand_map[card]++;
  }

  for (const [card, count] of Object.entries(selected_card)) {
    if (!hand_map[card])
      // selected card is not available in hand: illegal
      return false;
    else {
      //if there is, count should be equal to or less
      if (count > hand_map[card]) return false; // more is selected than what a user has: illega
    }
  }

  return true;
}

function checkRule(roomData, selected_card) {
  let count = 0;
  for (const [card, val] of Object.entries(selected_card)) {
    count += val;
  }

  // no more than two types of cards
  if (Object.keys(selected_card).length > 2) return false;
  // if there are, illegal
  else if (Object.keys(selected_card).length == 2 && !selected_card[13])
    // if there are two types of cards, one of them must be 13
    return false; //else illegal

  // last is merged as {num: no, count: count}
  if (roomData.game.last) {
    // card count should be the same
    if (roomData.game.last.count != count) return false; // else illegal

    //single card type which is normal, then 13 has no power
    if (Object.keys(selected_card).length == 1) {
      for (const [card, val] of Object.entries(selected_card)) {
        if (roomData.game.last.num - card <= 0) {
          // can't throw 13 alone
          console.log(roomData.game.last.num + " <= " + card);
          return false; // if any of card no. is equal/greater than the last one, no go
        }
      }
    } else {
      // more than 1 card type
      console.log("13 included");
      // case with with 13
      // except 13, the card no. must be smaller
      for (const [card, val] of Object.entries(selected_card)) {
        if (card != 13 && roomData.game.last.num - card <= 0) {
          return false; // if any of card no. is equal/greater than the last one, no go
        }
      }
    }

    // if everything checks, then good to go
    return true;
  } else {
    // there is no previous play, or deleted due to winning a round
    return true;
  }
}

function updateHand(socket, roomData, selected_card) {
  let sid = socket.id;
  let room_name = socket.userData.cur_room;
  let hand_map = {};
  for (let i = 0; i < roomData.sockets[sid].hand.length; i++) {
    let card = roomData.sockets[sid].hand[i];
    if (!hand_map[card]) hand_map[card] = 0;
    hand_map[card]++;
  }

  for (const [card, count] of Object.entries(selected_card)) {
    hand_map[card] -= count;
  }
  // map to list
  let new_hand = [];
  for (const [card, count] of Object.entries(hand_map)) {
    let m = count;
    while (m-- > 0) new_hand.push(card);
  }
  roomData.sockets[sid].hand = new_hand;

  // if your hand is empty? you win
}

http.listen(port, () => {
  console.log("Listening: " + port);
});
