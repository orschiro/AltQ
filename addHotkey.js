var altDown = false;
window.addEventListener('keyup', keyupFunction, true); 
window.addEventListener('keydown', keydownFunction, true); 

function keyupFunction(k) {
	if(k.isAlt || k.keyCode == 18) {
		altDown = false;
	}
}

function keydownFunction(k) {
	if(k.isAlt || k.keyCode == 18) {
		altDown = true;
	}
	if(altDown && k.keyCode == 81) {
		altDown = false;
		chrome.runtime.sendMessage({request:"toggle"}, function(response) {
			init();
		});
	}
	if(k.keyCode == 81) {
		if (k.altKey) {
			altDown = false;
			chrome.runtime.sendMessage({request:"toggle"}, function(response) {
				init();
			});
		}
	}
}