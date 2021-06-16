$(document).on("keydown", (e) => {
  var width = $(window).width();
  if (e.keyCode === 13 && width > 600) {
    e.preventDefault();
    $("#form-chatting").click();
  } else if (e.keyCode === 13 && width <= 600) {
    $("#form-chatting-media").click();
    e.preventDefault();
  }
});
