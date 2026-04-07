const url =document.getElementById("url");


const download=document.getElementById("download");
window.open("url")


function gototime(time) {
  video.currentTime = time;
}
gototime(download);


url.addEventListener("timeupdate", () => {
  console.log(url.currentTime);
});
