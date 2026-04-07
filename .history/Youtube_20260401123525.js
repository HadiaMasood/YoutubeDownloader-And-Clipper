const url =document.getElementById("url");


const download=document.getElementById("download");
window.open("url")


function gototime(time) {
  video.currentTime = time;
}
gototime(30);

gototime(second);
url.addEventListener("timeupdate", () => {
  console.log(url.currentTime);
});