let game_state = {
  WAITING: 0,
  PLAYING: 1,
};

let socket = io();

$(function () {
  // SET LANGUAGE
  let language;
  (function getLanguage() {
    localStorage.getItem("language") == null ? setLanguage("en") : false;
    $.ajax({
      url: "/js/language/" + localStorage.getItem("language") + ".json",
      dataType: "json",
      async: false,
      dataType: "json",
      success: function (lang) {
        language = lang;
      },
    });
  })();

  // TRASLATIONS
  $("#btnCreate").text(language.create);
  $("#btnJoin").text(language.join);
  $("#create").text(language.create);
  $("#join").text(language.join);
  $("#new-room-name-lang").text(language.newRoomName);
  $("#titleNickModal").text(language.titleNickModal);
  $("#joinRoomIdLang").text(language.newRoomName);
  $("#hideLang").text(language.hide);
  $("#new-room-create").text(language.btnCreate);
  $("#set-nickname-lang").text(language.setNickname);
  $("#set-nickname-ok").text(language.save);
  $("#joinRoomId").text(language.newRoomName);
  $("#joinRoom").text(language.btnJoin);
  $("#info").text(language.info);
  $("#howTo").text(language.howToPlay);
  $("#chooseLang").text(language.chooseLang);
  $("#play-btn").text(language.pass);
  $("#ready-btn").text(language.ready);
  $("#message-input").attr("placeholder", language.write);
  $("#form-chatting").text(language.send);
  $("#form-chatting-media").text(language.send);
  $("#shareTitle").text(language.shareTit);
  $("#roomIdShareLang").text(language.shareInvite);
  $("#close").text(language.close);

  // CHECK nickname OR SET NEW
  let nickname = localStorage.getItem("localnickname");
  if (nickname) {
    $(".nickname").html(`<div class="nameMedia">${nickname}</div>`);
    socket.emit(
      "set new nickname",
      nickname,
      window.location.href.substring(window.location.href.lastIndexOf("/") + 1)
    );
  } else {
    $("#newName").click();
  }

  socket.emit("init"); // for sender-only update

  // CREATE NEW ROOM
  $("#new-room-create").click(() => {
    const roomName = $("#new-room-name").val();
    const hide = $("#hide").is(":checked");

    if (roomName !== "") {
      $("#chat-messages").empty(); //empty chat log
      $("#chat-messages-media").empty(); //empty chat log
      showLoadingText();
      socket.emit("create game room", roomName, hide);
      $("#new-room-name").val("");
    } else {
      $("#noName").slideDown();
      setTimeout(() => {
        $("#noName").slideUp();
      }, 1500);
      return false;
    }
  });

  // JOIN ROOM
  $("#joinRoom").click(() => {
    const roomName = $("#joinRoomId").val();

    if (roomName !== "") {
      $("#chat-messages").empty(); //empty chat log
      $("#chat-messages-media").empty();
      showLoadingText();
      socket.emit("join game room", roomName);
      $("#joinRoomId").val("");
    } else {
      $("#noName").slideDown();
      setTimeout(() => {
        $("#noName").slideUp();
      }, 1500);
      return false;
    }
  });

  // UPDATE NICKNAME
  $("#set-nickname-ok").click(() => {
    let nickname = $("#set-nickname").val();

    if (nickname !== "") {
      localStorage.setItem("localnickname", nickname);
      socket.emit(
        "set new nickname",
        nickname,
        window.location.href.substring(
          window.location.href.lastIndexOf("/") + 1
        )
      );
      $(".nickname").html(`<div>${nickname}</div>`);
      $("#set-nickname").val("");
    } else {
      $("#noName").slideDown();
      setTimeout(() => {
        $("#noName").slideUp();
      }, 1500);
      return false;
    }
  });

  // CHAT HELPER
  $("#form-chatting").click(() => {
    if (!/<\/?[a-z][\s\S]*>/i.test($("#message-input").val())) {
      socket.emit("chat message", $("#message-input").val());

      $("#message-input").val("");
      return false;
    } else {
      $("#message-input").val("Not here my friend");
    }
    return false;
  });

  // CHAT HELPER
  $("#form-chatting-media").click(() => {
    if (!/<\/?[a-z][\s\S]*>/i.test($("#message-input-media").val())) {
      socket.emit("chat message", $("#message-input-media").val());

      $("#message-input-media").val("");
      return false;
    } else {
      $("#message-input-media").val("Not here my friend");
    }
    return false;
  });

  // RECEIVE MSG FROM SERVER
  socket.on("chat message", (nickname, msg) => {
    if (screen.width > 600) {
      $("#chat-messages").append($("<div>").html(`<b>${nickname}:</b> ${msg}`));
      $("#chat-messages").scrollTop($("#chat-messages").prop("scrollHeight"));
    } else {
      $("#chat-messages-media").append(
        $("<div>").html(`<b>${nickname}:</b> ${msg}`)
      );
      $("#chat-messages-media").scrollTop(
        $("#chat-messages-media").prop("scrollHeight")
      );
    }
  });

  // button, must be checked on server side
  $("#ready-btn").on("click", () => {
    if (!$("#ready-btn").hasClass("disabled")) {
      socket.emit("ready");

      if ($("#ready-btn").text() === language.notReady)
        $("#ready-btn").text(language.ready);
      else $("#ready-btn").text(language.notReady);
    }
  });

  // pass turn, next order
  $("#play-btn").on("click", () => {
    if (!$("#play-btn").hasClass("disabled")) {
      socket.emit("play", selected_card);
    }
  });

  // UPDATE WAITING ROOMS LIST IN MAIN
  socket.on("refresh waiting room", (user, rooms, user_count) => {
    let roomCount = 0;
    $("#room-list").empty(); // Clear before adding

    for (const [key, room] of Object.entries(rooms)) {
      appendGameRoom(key, Object.keys(room.sockets).length, room.game.state);
      roomCount++;
    }

    $("#title").html(
      `${language.title} <br><strong>${roomCount} ${language.room} | ${user_count} ${language.usersOnline}</strong>`
    );
  });

  // UPDATE TITLE
  socket.on("update sender", (user) => {
    $(".nickname").html(`<div>${user.nickname}</div>`);
    $("#room-title")
      .text(`${language.roomTitle} ${user.cur_room}`)
      .parent()
      .attr("id", `${user.cur_room}`);
    $("#roomIdShare").val(user.cur_room);
  });

  //Enter Game Room
  socket.on("refresh game room", (roomData, passed, socketInfo) => {
    if (roomData.game.state == game_state.WAITING) {
      $("#ready-btn").removeClass("disabled");
    } else {
      // start
      $("#ready-btn").addClass("disabled");
      $("#ready-btn").text(language.ready);
    }

    // List shared info
    reloadSlots(roomData);

    // Show cards
    reloadCards(socket.id, roomData);

    if (passed) reloadField(roomData, socketInfo); // Reload field only not passed

    // enable first player
    setPlayable(roomData);

    // Show Points
    showPoints(roomData.leaderBoard);
  });

  // Redirect to Room URL
  socket.on("connectUrl", (roomId) => {
    window.location.href = roomId;
  });

  //!	Personal Update

  // ALERT FROM SERVER
  socket.on("alert", (msg) => {
    $("#play-btn").removeClass("disabled");

    alert_big(eval(msg));
  });

  // FADE IN ALERT
  function alert_big(msg) {
    $("#error-msg-bg").fadeIn();
    $("#error-msg").text(msg);
    setTimeout(() => {
      $("#error-msg-bg").fadeOut();
    }, 3000);
  }

  //! Public(Shared) Update

  // SHOW GAMEROOM ON MAIN
  function appendGameRoom(name, length, state) {
    let str = "";
    if (state == game_state.WAITING) str = language.wait;
    else if (state == game_state.PLAYING) str = language.playing;

    let $newRoom = $(
      `<div class='p-4 w-100 mt-2 game-room rounded bg-secondary1'><strong>${language.roomTitle}</strong> ${name} <strong>${language.players}</strong> ${length} / 8 <strong>- ${str}</strong></div>`
    );

    // join room
    $newRoom.on("click", () => {
      showLoadingText();
      socket.emit("join game room", name);
      $("#chat-messages").empty();
      $("#chat-messages-media").empty();
    });

    $("#room-list").append($newRoom);
  }

  // SHOW POINTS
  function showPoints(leaderBoard) {
    $("#statistics").empty(); // Clear first
    $("#statistics-media").empty();
    // APPEND PLAYERS
    try {
      leaderBoard.forEach((val, i) => {
        let div;
        if (val[3] === "greaterDalmuti") {
          $(`#${val[2]}`).parent().parent().children().eq(0).removeClass();
          $(`#${val[2]}`)
            .parent()
            .parent()
            .children()
            .eq(0)
            .addClass("greaterDalmuti");
          div = $(
            `<div id=${val[2]} style="font-size: 1.5rem;" class="col w-100 pointsDiv"><i class="gg-crown"></i> ${val[1]}: ${val[0]}</div>`
          );
        } else if (val[3] === "lesserDalmuti") {
          $(`#${val[2]}`).parent().parent().children().eq(0).removeClass();
          $(`#${val[2]}`)
            .parent()
            .parent()
            .children()
            .eq(0)
            .addClass("lesserDalmuti");
          div = $(
            `<div id=${val[2]} style="font-size: 1.2rem;" class="col w-100 pointsDiv">${val[1]}: ${val[0]}</div>`
          );
        } else if (val[3] === "lesserPeon") {
          $(`#${val[2]}`).parent().parent().children().eq(0).removeClass();
          $(`#${val[2]}`)
            .parent()
            .parent()
            .children()
            .eq(0)
            .addClass("lesserPeon");
          div = $(
            `<div id=${val[2]} style="font-size: 0.8rem;" class="col w-100 pointsDiv">${val[1]}: ${val[0]}</div>`
          );
        } else if (val[3] === "greaterPeon") {
          $(`#${val[2]}`).parent().parent().children().eq(0).removeClass();
          $(`#${val[2]}`)
            .parent()
            .parent()
            .children()
            .eq(0)
            .addClass("greaterPeon");
          div = $(
            `<div id=${val[2]} style="font-size: 0.8rem;" class="col w-100 pointsDiv">${val[1]}: ${val[0]}</div>`
          );
        } else {
          $(`#${val[2]}`).parent().parent().children().eq(0).removeClass();
          $(`#${val[2]}`)
            .parent()
            .parent()
            .children()
            .eq(0)
            .addClass("merchant");
          div = $(
            `<div id=${val[2]} class="col w-100 pointsDiv">${val[1]}: ${val[0]}</div>`
          );
        }
        let spaceDiv = $('<div class="w-100"></div>');
        $("#statistics").append(div, spaceDiv);
        $("#statistics-media").append(div, spaceDiv);
      });
    } catch (error) {
      // console.log(error);
    }
  }

  // CONNECT AND DISCCONECT CHAT MSG
  socket.on("chat connection", (user) => {
    //connected to chat
    if (screen.width > 600) {
      if (user.seat > -1)
        $("#chat-messages").append(
          $("<div>")
            .text(user.nickname + language.connected)
            .addClass("font-weight-bold")
        );
      else
        $("#chat-messages").append(
          $("<div>")
            .text(user.nickname + language.disconnected)
            .addClass("font-weight-bold")
        );
      $("#chat-messages").scrollTop($("#chat-messages").prop("scrollHeight"));
    } else {
      if (user.seat > -1)
        $("#chat-messages-media").append(
          $("<div>")
            .text(user.nickname + language.connected)
            .addClass("font-weight-bold")
        );
      else
        $("#chat-messages-media").append(
          $("<div>")
            .text(user.nickname + language.disconnected)
            .addClass("font-weight-bold")
        );
      $("#chat-messages-media").scrollTop(
        $("#chat-messages-media").prop("scrollHeight")
      );
    }
  });

  // CHAT ANNUNCE FUNCTION
  socket.on("chat announce", (msg, color, nickname, nickname1) => {
    let $new_msg;
    if (nickname && nickname1) {
      $new_msg = $("<div>").text(nickname1 + " " + eval(msg) + " " + nickname);
    } else if (nickname) {
      $new_msg = $("<div>").text(nickname + " " + eval(msg));
    } else {
      $new_msg = $("<div>").text(eval(msg));
    }
    $new_msg.css("color", color);
    $new_msg.addClass("font-weight-bold");

    if (screen.width > 600) {
      $("#chat-messages").append($new_msg);
      $("#chat-messages").scrollTop($("#chat-messages").prop("scrollHeight"));
    } else {
      $("#chat-messages-media").append($new_msg);
      $("#chat-messages-media").scrollTop(
        $("#chat-messages-media").prop("scrollHeight")
      );
    }
  });

  // CHAT ANNUNCE TAXS
  socket.on("chat announce taxs", (msg, color, paied, received) => {
    let arrMess = eval(msg);
    let $new_msg = $("<div>").html(
      `${arrMess[0]} ${paied}<br>${arrMess[1]} ${received}`
    );
    $new_msg.css("color", color);
    $new_msg.addClass("font-weight-bold");
    if (screen.width > 600) {
      $("#chat-messages").append($new_msg);
      $("#chat-messages").scrollTop($("#chat-messages").prop("scrollHeight"));
    } else {
      $("#chat-messages-media").append($new_msg);
      $("#chat-messages-media").scrollTop(
        $("#chat-messages-media").prop("scrollHeight")
      );
    }
  });

  // CHECK TURN
  function setPlayable(roomData) {
    let cur = -1;
    if (roomData.game.state == game_state.PLAYING)
      cur = roomData.game.cur_order_idx;

    for (let i = 0; i < 8; i++) {
      $("#player" + i)
        .parent()
        .removeClass("currentTurn");
    }

    $("#play-btn").addClass("disabled");

    for (const [sid, userData] of Object.entries(roomData.sockets)) {
      // IF IS USER ABILITATE TO PLAY CARD OR JUST SET TURN UI
      if (cur == userData.seat && sid == socket.id) {
        alert_big(language.yourTurn);
        $("#play-btn").removeClass("disabled");
        $("#player" + cur)
          .parent()
          .addClass("currentTurn");
      } else if (cur == userData.seat) {
        $("#player" + cur)
          .parent()
          .addClass("currentTurn");
      }
    }
  }

  // SHOW LOADING ANIMATION
  function showLoadingText() {
    $("#title").text(language.connecting);
    $("#room-list").empty();
  }

  // RELOAD PLAYERS SLOTS
  function reloadSlots(roomData) {
    for (let i = 0; i < 8; i++) {
      $("#player" + i)
        .parent()
        .removeClass("top");
      $("#player" + i).empty();
    }

    if (roomData.leaderBoard && roomData.game.state === game_state.WAITING) {
      roomData.leaderBoard.forEach((val, i) => {
        $("#player" + i).append(
          $("<div id=" + val[2] + "><b>" + val[1] + "</b></div>"),
          $(
            "<div class='fontMediaSlots'>" +
              language.cards +
              " " +
              roomData.sockets[val[2]].hand.length +
              "</div>"
          )
        );
        if (roomData.game.state == game_state.WAITING) {
          if (roomData.sockets[val[2]].ready) {
            $("#player" + i).append(
              $(
                "<div class='fontMediaSlots' style='color:var(--success1);'>" +
                  language.ready +
                  "</div>"
              )
            );
          } else {
            $("#player" + i).append(
              $(
                "<div class='fontMediaSlots' style='color:var(--alert1);'>" +
                  language.notReady +
                  "</div>"
              )
            );
          }
        } else {
          if (roomData.sockets[val[2]].ready) {
            if (roomData.sockets[val[2]].hand.length == 0)
              $("#player" + i).append(
                $(
                  "<div class='fontMediaSlots' style='color:var(--success1);'>" +
                    language.winner +
                    "</div>"
                )
              );
          } // not ready, not in game
          else {
            for (const [sid, user] of Object.entries(roomData.sockets)) {
              if (roomData.leaderBoard.find((el) => el[2] === sid)) {
                $("#player" + user.seat).append(
                  $("<div id=" + sid + "><b>" + user.nickname + "</b></div>"),
                  $(
                    "<div class='fontMediaSlots'>" +
                      language.cards +
                      " " +
                      user.hand.length +
                      "</div>"
                  )
                );
                $("#player" + user.seat).append(
                  $(
                    "<div class='fontMediaSlots' style='color:var(--primary1);'>" +
                      language.spect +
                      "</div>"
                  )
                );
              }
            }
          }
        }
      });
    } else {
      for (const [sid, user] of Object.entries(roomData.sockets)) {
        $("#player" + user.seat).append(
          $("<div id=" + sid + "><b>" + user.nickname + "</b></div>"),
          $(
            "<div class='fontMediaSlots'>" +
              language.cards +
              " " +
              user.hand.length +
              "</div>"
          )
        );

        if (roomData.game.state == game_state.WAITING) {
          if (user.ready) {
            $("#player" + user.seat).append(
              $(
                "<div class='fontMediaSlots' style='color:var(--success1);'>" +
                  language.ready +
                  "</div>"
              )
            );
          } else {
            $("#player" + user.seat).append(
              $(
                "<div class='fontMediaSlots' style='color:var(--alert1);'>" +
                  language.notReady +
                  "</div>"
              )
            );
          }
        } else {
          if (user.ready) {
            if (user.hand.length == 0)
              $("#player" + user.seat).append(
                $(
                  "<div class='fontMediaSlots' style='color:var(--success1);'>" +
                    language.winner +
                    "</div>"
                )
              );
          } // not ready, not in game
          else
            $("#player" + user.seat).append(
              $(
                "<div class='fontMediaSlots' style='color:var(--primary1);'>" +
                  language.spect +
                  "</div>"
              )
            );
        }
      }
    }

    for (let i = 0; i < 8; i++) {
      if ($("#player" + i).children().length === 0) {
        $("#player" + i)
          .parent()
          .addClass("top");
        $("#player" + i).append(
          '<i data-toggle="modal" data-target="#shareRoom" class="material-icons" style="font-size:36px">person_add</i>'
        );
      }
    }
  }

  //! CARDS STYLE
  var card_colors = [
    "dalmuti",
    "archbishop",
    "marshal",
    "baroness",
    "abbess",
    "knight",
    "seamstress",
    "mason",
    "cook",
    "shepherdess",
    "stonecutter",
    "peasant",
    "jolly",
  ];
  var selected_card = {};

  function reloadCards(sid, roomData) {
    selected_card = {};
    $("#play-btn")
      .text(language.pass)
      .addClass("bg-alert1")
      .removeClass("btn-success");

    // card -1
    // its roomData not user
    let userData = roomData.sockets[sid];

    userData.hand.sort(function (a, b) {
      return a - b;
    });
    let actual_card_count = 1;

    // DO ANIMATION ONLY IF CAN PLAY CARDS
    if (!$("#play-btn").hasClass("disabled")) {
      // Fade cards out
      $($(".selected").get().reverse()).each(function (fadeInDiv) {
        $(this)
          .delay(fadeInDiv * 100)
          .fadeOut(300);
      });
      $("#play-btn").addClass("disabled");
    }
    $(".selected")
      .promise()
      .done(function () {
        $("#hand").empty();

        for (let i = 0; i < userData.hand.length; i++) {
          let $carddiv;
          // BACKGROUND COLOR = card_colors[userData.hand[i] - 1]
          if (userData.hand[i] != -1) {
            $carddiv = $(
              `<div class='cards text-center ${
                card_colors[userData.hand[i] - 1]
              }'></div>`
            );

            $carddiv.on("mouseenter", () => {
              if (!$carddiv.hasClass("selected")) $carddiv.addClass("cardSel");
            });
            $carddiv.on("mouseleave", () => {
              if (!$carddiv.hasClass("selected"))
                $carddiv.removeClass("cardSel");
            });

            $carddiv.on("click", () => {
              if (!selected_card[userData.hand[i]])
                selected_card[userData.hand[i]] = 0;

              if ($carddiv.hasClass("selected")) {
                // unselect
                selected_card[userData.hand[i]]--;
                if (selected_card[userData.hand[i]] == 0)
                  delete selected_card[userData.hand[i]];

                $carddiv.removeClass("selected");
              } else {
                //select
                selected_card[userData.hand[i]]++;
                $carddiv.addClass("selected");
              }

              // play/pass
              if (Object.keys(selected_card).length == 0) {
                $("#play-btn")
                  .text(language.pass)
                  .addClass("bg-alert1")
                  .removeClass("bg-success1");
              } else {
                $("#play-btn")
                  .text(language.play)
                  .removeClass("bg-alert1")
                  .addClass("bg-success1");
              }
            });

            $("#hand").append($carddiv);
            actual_card_count++;
          }
        }
      });
  }

  function reloadField(roomData, socketInfo) {
    $("#whoPlayed").empty();
    $("#field-section")
      .children()
      .each((i, val) => $(val).removeClass("active").fadeOut(300))
      .promise()
      .done((elem) => {
        elem.parent().empty();
        if (roomData.game.state == game_state.PLAYING)
          if (roomData.game.last) {
            $("#whoPlayed").text(`${socketInfo.nickname} ${language.placed}`);

            // to array
            let last_hand = roomData.game.last;
            delete last_hand.num;
            delete last_hand.count;
            let last_array = [];
            for (const [card, count] of Object.entries(last_hand)) {
              let m = count;
              while (m-- > 0) last_array.push(card);
            }

            //console.log(last_array)

            for (let i = 0; i < last_array.length; i++) {
              let backCard = $("<div class='flip-card-front backCard'>");
              let $carddiv = $(
                `<div class='flip-card-back text-center fieldCards ${
                  card_colors[last_array[i] - 1]
                }'></div>`
              );
              let parentDiv = $(
                "<div class='flip-card-inner fieldCards' style='display:none;margin:3px;'>"
              );
              parentDiv.append(backCard, $carddiv);
              $("#field-section").append(parentDiv);
            }

            $($(".fieldCards").get().reverse()).each(function (fadeInDiv) {
              $(this)
                .delay(fadeInDiv * 100)
                .fadeIn(300);
            });

            $(".fieldCards")
              .promise()
              .done(() => {
                $(".flip-card .flip-card-inner").addClass("active");
              });
          }
      });
  }

  $(document).on("keydown", (e) => {
    if (e.keyCode === 13 && $("#id02").css("display") !== "none") {
      e.preventDefault();
      $("#set-nickname-ok").click();
    } else if (e.keyCode === 13) e.preventDefault();
  });

  $("#chatMedia").click(function () {
    $(".chatStatDivMedia").toggleClass("chatDiv");
    $("#chatMedia").toggleClass("chatActive");
  });
});
