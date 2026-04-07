const url =document.getElementById("url");


const download=document.getElementById("download");
window.open("url")


function gototime(time) {
  video.currentTime = time;
}

gototime(30);
url.addEventListener("timeupdate", () => {
  console.log(url.currentTime);
});