// usage: node check.js <dir containing src/lib.js>
const path=require('path');const lib=require(path.resolve(process.argv[2],'src/lib.js'));
(async()=>{
const out={};
out.price=lib.price([{sku:'a',qty:2,unit:3.5},{sku:'b',qty:1,unit:10}],'DE');
out.priceUS=lib.price([{sku:'a',qty:3,unit:1.99}],'US');
try{lib.price([{sku:'x',qty:-1,unit:1}],'US')}catch(e){out.err=e.name+':'+e.message}
out.fib=[...lib.fib(12)];
const c=new lib.Cart('JP').add('z',4,2.25).add('y',1,100);out.cart=[c.total,c.size,JSON.stringify(c)];
out.phone=[lib.parsePhone('555-1234'),lib.parsePhone('bad')];
out.cls=[-5,0,3,99].map(lib.classify);
out.next=[lib.next(),lib.next()];
out.sq=[lib.slowSquare(7),lib.slowSquare(7)];
out.del=await lib.delayed(21);
out.lic=[lib.license('PRO-1234567890AB'),lib.license('TRIAL'),lib.license('x')];
out.render=lib.render('Hi {{n}} {{q}}!',{n:'Bob'});
out.greet=lib.GREETING;out.tax=lib.TAX;
console.log(JSON.stringify(out));
})();
