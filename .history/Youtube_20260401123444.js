const url =document.getElementById("url");


const download=document.getElementById("download");
window.open("url")

const second= prompt("ENterz")
function gototime(time) {
  video.currentTime = time;
}

gototime(second);
url.addEventListener("timeupdate", () => {
  console.log(url.currentTime);
});