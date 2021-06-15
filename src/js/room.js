$(document).on("keydown", (e) => {
    if (e.keyCode === 13) {
      e.preventDefault();
      $("#form-chatting").click();
    } else if (e.keyCode === 13) e.preventDefault();
  });
  