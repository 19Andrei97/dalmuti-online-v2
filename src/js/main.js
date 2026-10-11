/* The Great Dalmuti - client controller. */
let game_state = { WAITING: 0, PLAYING: 1, TAXATION: 2 };

let socket = io();
let currentUser = null;
let width = $(window).width();
$(window).on("resize", () => {
  width = $(window).width();
});

// Server messages are language keys (e.g. "language.started"); resolve them
// against the loaded dictionary instead of eval(). The dictionary keys omit the
// leading "language." namespace, so strip it before the lookup.
function resolveMessage(key) {
  if (typeof key !== "string") return String(key);
  const parts = key.split(".");
  if (parts[0] === "language") parts.shift();
  let value = window.language;
  for (const part of parts) {
    if (value == null) break;
    value = value[part];
  }
  return value != null ? value : key;
}

$(function () {
  // SET LANGUAGE
  (function getLanguage() {
    if (localStorage.getItem("language") == null) setLanguage("en");
    $.ajax({
      url: "/js/language/" + localStorage.getItem("language") + ".json",
      dataType: "json",
      async: false,
      success: function (lang) {
        window.language = lang;
      },
      error: function () {
        window.language = window.language || {};
      },
    });
  })();
  const language = window.language;

  // TRANSLATIONS
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
  $("#message-input-media").attr("placeholder", language.write);
  $("#leaderboard").children().eq(0).text(language.leaderboard);
  $("#leaderboard-media").children().eq(0).text(language.leaderboard);
  $("#add-bot-btn").text(language.addBot);
  $("#addBotTitle").text(language.addBotTitle);
  $("#botDifficultyLang").text(language.botDifficulty);
  $("#add-bot-confirm").text(language.botAdd);
  $("#fill-bots").text(language.fillBots);
  $("#bot-difficulty option[value='easy']").text(language.difficultyEasy);
  $("#bot-difficulty option[value='medium']").text(language.difficultyMedium);
  $("#bot-difficulty option[value='hard']").text(language.difficultyHard);

  // AUTH / identity. The account system may be disabled (guest mode): then the
  // player picks a nickname locally and no /login redirect happens.
  let authEnabled = false;

  function afterAuth(data) {
    const username = data && data.authEnabled ? data.username : null;
    authEnabled = !!(data && data.authEnabled);
    currentUser = username ? { username } : null;

    if (authEnabled) {
      if (username) {
        $(".nickname").text(username);
        socket.emit("set new nickname", username, currentRoomId());
      } else if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
      return;
    }

    // Guest mode: allow the nickname modal, restore any saved name.
    $("#newName").attr("data-toggle", "modal");
    const saved = localStorage.getItem("nickname");
    if (saved) {
      $(".nickname").text(saved);
      socket.emit("set new nickname", saved, currentRoomId());
    }
  }

  $.getJSON("/api/me")
    .done(afterAuth)
    .fail(() => afterAuth({ authEnabled: false }));

  function currentRoomId() {
    const parts = window.location.pathname.split("/");
    return parts[parts.length - 1];
  }

  // Attempt to resume a dropped session (seat + hand) before anything else.
  const reconnectToken = localStorage.getItem("reconnectToken");
  if (reconnectToken) socket.emit("reconnect", reconnectToken);

  socket.emit("init");

  // CREATE NEW ROOM
  $("#new-room-create").click(() => {
    const roomName = $("#new-room-name").val();
    const hide = $("#hide").is(":checked");
    if (roomName !== "") {
      $("#chat-messages").empty();
      $("#chat-messages-media").empty();
      showLoadingText();
      socket.emit("create game room", roomName, hide);
      $("#new-room-name").val("");
    } else {
      $("#noName").slideDown();
      setTimeout(() => $("#noName").slideUp(), 1500);
      return false;
    }
  });

  // JOIN ROOM
  $("#joinRoom").click(() => {
    const roomName = $("#joinRoomId").val();
    if (roomName !== "") {
      $("#chat-messages").empty();
      $("#chat-messages-media").empty();
      showLoadingText();
      socket.emit("join game room", roomName);
      $("#joinRoomId").val("");
    } else {
      $("#noName").slideDown();
      setTimeout(() => $("#noName").slideUp(), 1500);
      return false;
    }
  });

  // LEAVE ROOM
  $("#home").on("click", (e) => {
    if ($("#home").hasClass("disabled")) return;
    e.preventDefault();
    socket.emit("leave room");
  });

  // UPDATE NICKNAME. With auth on, the name is the account name; in guest mode
  // the player's own choice is kept in localStorage.
  $("#set-nickname-ok").click(() => {
    const typed = $("#set-nickname").val();
    if (authEnabled) {
      if (currentUser) {
        $(".nickname").text(currentUser.username);
        socket.emit("set new nickname", currentUser.username, currentRoomId());
      }
    } else if (typed !== "") {
      localStorage.setItem("nickname", typed);
      $(".nickname").text(typed);
      socket.emit("set new nickname", typed, currentRoomId());
    }
    $("#set-nickname").val("");
  });

  // CHAT SEND (client-side pre-check only; server enforces)
  function sendChat(inputSel) {
    const value = $(inputSel).val();
    if (value === "") return false;
    socket.emit("chat message", value);
    $(inputSel).val("");
    return false;
  }
  $("#form-chatting").click(() => sendChat("#message-input"));
  $("#form-chatting-media").click(() => sendChat("#message-input-media"));

  // RECEIVE CHAT
  socket.on("chat message", (nickname, msg, serverSocket) => {
    const $div = $("<div>");
    $("<b>").text(nickname + ":").appendTo($div);
    $div.append(document.createTextNode(" " + msg));
    if (socket.id === serverSocket) $div.css("color", "var(--info)");
    appendChat($div);
  });

  function appendChat($el) {
    const target = width > 600 ? "#chat-messages" : "#chat-messages-media";
    $(target).append($el);
    $(target).scrollTop($(target).prop("scrollHeight"));
  }

  // READY
  $("#ready-btn").on("click", () => {
    if (!$("#ready-btn").hasClass("disabled")) {
      socket.emit("ready");
      if ($("#ready-btn").text() === language.notReady)
        $("#ready-btn").text(language.ready);
      else $("#ready-btn").text(language.notReady);
    }
  });

  // BOTS: add (single) / fill / remove
  $("#add-bot-confirm").on("click", () => {
    socket.emit("add bot", $("#bot-difficulty").val());
  });
  $("#fill-bots").on("click", () => {
    socket.emit("fill bots", $("#bot-difficulty").val());
  });

  function difficultyLabel(diff) {
    if (diff === "easy") return language.difficultyEasy;
    if (diff === "hard") return language.difficultyHard;
    return language.difficultyMedium;
  }

  function renderBotList(roomData) {
    const bots = Object.entries(roomData.players).filter(([, u]) => u.isBot);
    $("#bot-list").empty();
    if (!bots.length) return;
    $("#bot-list").append(
      $("<div>").addClass("font-weight-bold").text(language.botsTitle)
    );
    for (const [sid, u] of bots) {
      const $row = $("<div>").addClass("d-flex justify-content-between align-items-center my-1");
      $row.append($("<span>").text(`${u.nickname} (${difficultyLabel(u.difficulty)})`));
      $("<button>")
        .addClass("btn btn-sm bg-alert1")
        .text(language.removeBot)
        .on("click", () => socket.emit("remove bot", sid))
        .appendTo($row);
      $("#bot-list").append($row);
    }
  }

  // PLAY / PASS
  $("#play-btn").on("click", () => {
    if ($("#play-btn").hasClass("disabled")) return;
    if (
      $("#play-btn").text() === language.pass &&
      $("#field-section").children().length === 0
    ) {
      if (confirm(language.confirmPass)) socket.emit("play", selected_card);
    } else {
      socket.emit("play", selected_card);
    }
  });

  // LOBBY ROOM LIST
  socket.on("refresh waiting room", (rooms, user_count) => {
    $("#room-list").empty();
    let roomCount = 0;
    for (const [key, room] of Object.entries(rooms)) {
      appendGameRoom(key, room.players, room.state);
      roomCount++;
    }
    $("#title").html(
      `${language.title} <br><strong>${roomCount} ${language.room} | ${user_count} ${language.usersOnline}</strong>`
    );
  });

  // SENDER UPDATE
  socket.on("update sender", (user) => {
    if (user.token) localStorage.setItem("reconnectToken", user.token);
    $(".nickname").text(user.nickname);
    $("#room-title")
      .text(`${language.roomTitle} ${user.cur_room}`)
      .parent()
      .attr("id", `${user.cur_room}`);
    $("#roomIdShare").val(user.cur_room);
  });

  // GAME ROOM STATE (per-recipient view)
  socket.on("refresh game room", (roomData) => {
    window.roomData = roomData;
    if (roomData.state === game_state.WAITING) {
      $("#ready-btn").removeClass("disabled");
      $("#home").removeClass("disabled");
    } else {
      $("#ready-btn").addClass("disabled");
      $("#home").removeClass("disabled");
      $("#ready-btn").text(language.ready);
    }

    // Only the host can manage bots, and only while waiting for a game.
    if (roomData.you === roomData.host && roomData.state === game_state.WAITING) {
      $("#add-bot-btn").show().prop("disabled", !roomData.canAddBot);
    } else {
      $("#add-bot-btn").hide();
    }
    renderBotList(roomData);

    reloadSlots(roomData);
    reloadCards(roomData);
    reloadField(roomData);
    setPlayable(roomData);
    showPoints(roomData);

    // Keep the tax prompt's card choices in sync with the freshly dealt hand.
    if (
      roomData.phase &&
      roomData.phase.type === "tax" &&
      window.taxPhase &&
      $("#tax-panel").is(":visible")
    ) {
      reloadTaxCards(window.taxPhase);
    }
    if (!roomData.phase || roomData.phase.type !== "revolution") {
      $("#revolution-panel").slideUp();
    }
    if (!roomData.phase || roomData.phase.type !== "tax") {
      $("#tax-panel").slideUp();
    }
  });

  socket.on("connectUrl", (roomId) => {
    window.location.href = roomId;
  });

  // ALERT (no eval)
  socket.on("alert", (msg) => {
    alert_big(resolveMessage(msg));
  });

  function alert_big(msg) {
    $("#error-msg-bg").fadeIn();
    $("#error-msg").text(msg);
    setTimeout(() => $("#error-msg-bg").fadeOut(), 3000);
  }

  // CHAT ANNOUNCE (no eval; text only)
  socket.on("chat announce", (msg, color, nickname, nickname1) => {
    const $new_msg = $("<div>");
    let text = resolveMessage(msg);
    if (nickname && nickname1) text = `${nickname1} ${text} ${nickname}`;
    else if (nickname) text = `${nickname} ${text}`;
    $new_msg.text(text);
    $new_msg.css("color", color);
    $new_msg.addClass("font-weight-bold");
    appendChat($new_msg);
  });

  socket.on("chat announce taxs", (msg, color, paid, received) => {
    const arrMess = resolveMessage(msg);
    const lines = Array.isArray(arrMess) ? arrMess : ["", ""];
    const $new_msg = $("<div>");
    $new_msg.append(document.createTextNode(`${lines[0]} ${paid}`));
    $new_msg.append($("<br>"));
    $new_msg.append(document.createTextNode(`${lines[1]} ${received}`));
    $new_msg.css("color", color);
    $new_msg.addClass("font-weight-bold");
    appendChat($new_msg);
  });

  // REVOLUTION PHASE
  socket.on("revolution phase", (info) => {
    $("#revolution-btn")
      .removeClass("disabled")
      .off("click")
      .on("click", () => {
        socket.emit("declare revolution");
        $("#revolution-btn").addClass("disabled");
      });
    $("#revolution-panel").slideDown();
    if (info.greater) alert_big(language.revolutionPromptGreater);
    else alert_big(language.revolutionPrompt);
  });

  // TAX PHASE
  socket.on("tax phase", (info) => {
    window.taxPhase = info;
    $("#tax-panel").slideDown();
    $("#tax-title").text(
      info.role === "peon"
        ? language.taxPeonPrompt
        : language.taxDalmutiPrompt
    );
    $("#tax-submit")
      .off("click")
      .on("click", () => {
        const chosen = {};
        $(".tax-card.selected").each(function () {
          const v = Number($(this).data("value"));
          chosen[v] = (chosen[v] || 0) + 1;
        });
        socket.emit("tax", chosen);
        $("#tax-panel").slideUp();
      });
    reloadTaxCards(info);
  });

  function reloadTaxCards(info) {
    const me = window.roomData ? window.roomData.you : null;
    const hand = window.roomData ? window.roomData.hand : [];
    $("#tax-hand").empty();
    let selected = 0;
    const unique = [...new Set(hand)].sort((a, b) => a - b);
    for (const value of unique) {
      const count = hand.filter((c) => c === value).length;
      const $card = $(
        `<div class='handCard cards text-center ${card_colors[value - 1]}'></div>`
      );
      $card.data("value", value);
      $card.on("click", () => {
        if ($card.hasClass("selected")) {
          $card.removeClass("selected");
          selected--;
        } else if (selected < info.count) {
          $card.addClass("selected");
          selected++;
        }
        $("#tax-submit").prop("disabled", selected !== info.count);
      });
      $("#tax-hand").append($card);
      if (count > 1) $("#tax-hand").append($("<span>").text("x" + count));
    }
    $("#tax-submit").prop("disabled", true);
    void me;
  }

  // TURN UI
  function setPlayable(roomData) {
    for (let i = 0; i < 8; i++) $("#player" + i).parent().removeClass("currentTurn");
    $("#play-btn").addClass("disabled");

    const cur = roomData.state === game_state.PLAYING ? roomData.cur_order_idx : -1;
    for (const [sid, userData] of Object.entries(roomData.players)) {
      if (cur === userData.seat && sid === roomData.you) {
        $("#play-btn").removeClass("disabled");
        $("#player" + cur).parent().addClass("currentTurn");
      } else if (cur === userData.seat) {
        $("#player" + cur).parent().addClass("currentTurn");
      }
    }
  }

  function showLoadingText() {
    $("#title").text(language.connecting);
    $("#room-list").empty();
  }

  // PLAYER SLOTS
  function reloadSlots(roomData) {
    for (let i = 0; i < 8; i++) {
      $("#player" + i).parent().removeClass("top");
      $("#player" + i).empty();
      $("#player" + i).prev().removeClass();
    }

    const bySeat = {};
    for (const [sid, user] of Object.entries(roomData.players)) {
      if (user.seat >= 0 && !user.spectator) bySeat[user.seat] = { sid, user };
    }

    for (const seat of Object.keys(bySeat)) {
      const { sid, user } = bySeat[seat];
      const $name = $("<b>").text(user.nickname);
      if (user.isBot) {
        $name.append($("<span>").addClass("badge badge-secondary ml-1").text(language.botLabel));
      }
      $("#player" + seat).append(
        $("<div>", { id: sid }).append($name),
        $("<div>").addClass("fontMediaSlots").text(`${language.cards} ${user.handCount}`)
      );
      if (roomData.state === game_state.WAITING) {
        $("#player" + seat).append(
          $("<div>")
            .addClass("fontMediaSlots")
            .css("color", user.ready ? "var(--success1)" : "var(--alert1)")
            .text(user.ready ? language.ready : language.notReady)
        );
      } else if (user.handCount === 0) {
        $("#player" + seat).append(
          $("<div>")
            .addClass("fontMediaSlots")
            .css("color", "var(--success1)")
            .text(language.winner)
        );
      } else if (user.role) {
        $("#player" + seat).parent().children().eq(0).addClass(user.role);
      }
    }

    // Spectators
    const spectators = Object.entries(roomData.players).filter(
      ([, u]) => u.spectator
    );
    if (spectators.length) {
      $("#spectator-list").empty();
      for (const [sid, u] of spectators) {
        $("#spectator-list").append($("<div>").attr("id", sid).text(u.nickname));
      }
    }

    for (let i = 0; i < 8; i++) {
      if ($("#player" + i).children().length === 0) {
        $("#player" + i).parent().addClass("top");
        $("#player" + i).append(
          '<i data-toggle="modal" data-target="#shareRoom" class="material-icons" style="font-size:36px">person_add</i>'
        );
      }
    }
  }

  //! CARDS
  var card_colors = [
    "dalmuti", "archbishop", "marshal", "baroness", "abbess", "knight",
    "seamstress", "mason", "cook", "shepherdess", "stonecutter", "peasant", "jolly",
  ];
  var selected_card = {};

  function reloadCards(roomData) {
    selected_card = {};
    $("#play-btn")
      .text(language.pass)
      .addClass("bg-alert1")
      .removeClass("bg-success1");

    const hand = roomData.hand.slice().sort((a, b) => a - b);
    $("#hand").empty();

    for (let i = 0; i < hand.length; i++) {
      const value = hand[i];
      const $carddiv = $("<div>")
        .addClass("handCard cards text-center")
        .addClass(card_colors[value - 1]);
      $carddiv.on("click", () => {
        if (!selected_card[value]) selected_card[value] = 0;
        if ($carddiv.hasClass("selected")) {
          selected_card[value]--;
          if (selected_card[value] === 0) delete selected_card[value];
          $carddiv.removeClass("selected");
        } else {
          selected_card[value]++;
          $carddiv.addClass("selected");
        }
        if (Object.keys(selected_card).length === 0) {
          $("#play-btn").text(language.pass).addClass("bg-alert1").removeClass("bg-success1");
        } else {
          $("#play-btn").text(language.play).removeClass("bg-alert1").addClass("bg-success1");
        }
      });
      $("#hand").append($carddiv);
    }
  }

  function reloadField(roomData) {
    $("#whoPlayed").empty();
    $("#field-section").empty();
    if (roomData.state !== game_state.PLAYING || !roomData.last) return;
    if (!roomData.last.num) return;

    const last = roomData.last;
    const lastArray = [];
    for (let i = 0; i < last.count; i++) lastArray.push(last.num);

    const who = roomData.socialOrder
      ? roomData.players[
          Object.keys(roomData.players).find(
            (sid) => roomData.players[sid].seat === roomData.cur_order_idx
          )
        ]
      : null;
    if (who) $("#whoPlayed").text(`${who.nickname} ${language.placed}`);

    for (let i = 0; i < lastArray.length; i++) {
      const $carddiv = $("<div>")
        .addClass("flip-card-back text-center fieldCards")
        .addClass(card_colors[lastArray[i] - 1]);
      const $back = $("<div class='flip-card-front backCard'>");
      const $inner = $("<div class='flip-card-inner fieldCards'>").css({
        display: "none",
        margin: "3px",
      });
      $inner.append($back, $carddiv);
      $("#field-section").append($inner);
    }
    // Fade the cards in, then flip them to reveal the played rank. Without the
    // `active` class the faces stay hidden and only the card backs are visible.
    $(".fieldCards")
      .fadeIn(300)
      .promise()
      .done(() => {
        $("#field-section .flip-card-inner").addClass("active");
      });
  }

  function showPoints(roomData) {
    $("#statistics").empty();
    $("#statistics-media").empty();
    if (!roomData.leaderBoard) return;
    for (const row of roomData.leaderBoard) {
      const $div = $("<div>")
        .addClass("col w-100 pointsDiv")
        .text(`${row.nickname}: ${row.points}`);
      if (row.role === "greaterDalmuti") $div.css({ "font-size": "1.5rem", color: "burlywood" });
      else if (row.role === "lesserDalmuti") $div.css("font-size", "1.2rem");
      else if (row.role === "lesserPeon" || row.role === "greaterPeon")
        $div.css("font-size", "0.8rem");
      const $slot = $(`#${row.sid}`).parent().parent().children().eq(0);
      if ($slot.length) $slot.removeClass().addClass(row.role || "merchant");
      const spaceDiv = $('<div class="w-100"></div>');
      if (width > 600) $("#statistics").append($div, spaceDiv);
      else $("#statistics-media").append($div, spaceDiv);
    }
  }

  // CHAT CONNECTION
  socket.on("chat connection", (user) => {
    const $div = $("<div>")
      .text(user.nickname + (user.connected === false ? language.disconnected : language.connected))
      .addClass("font-weight-bold");
    appendChat($div);
  });

  // ENTER KEY
  $(document).on("keydown", (e) => {
    if (e.keyCode === 13) {
      if ($("#id02").css("display") !== "none") {
        e.preventDefault();
        $("#set-nickname-ok").click();
      } else if ($(e.target).is("input, textarea")) {
        e.preventDefault();
      }
    }
  });

  $("#chatMedia").click(function () {
    $(".chatStatDivMedia").toggleClass("chatDiv");
    $("#chatMedia").toggleClass("chatActive");
  });

  $(".lang-link").on("click", function (e) {
    e.preventDefault();
    setLanguage($(this).data("lang"));
  });
});

function setLanguage(lang) {
  localStorage.setItem("language", lang);
  location.reload();
}
